// Image session continuity: fixtures only. These exercise the real MCP SDK
// protocol against scripted app-server peers and injected capability results;
// they prove the bridge's protocol handling, not live native image edits.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IMAGE_DEVELOPER_INSTRUCTIONS, IMAGE_THREAD_NAME } from "../src/image-service.js";
import { ImageSessionStore, isSessionHandleShape, SESSION_LIMITS, type SessionContext } from "../src/image-sessions.js";
import {
  capabilitiesFromMethods,
  discoverImageCapabilities,
  methodsFromClientRequest,
  type ImageProtocolCapabilities,
} from "../src/protocol-capabilities.js";
import { buildServer, makeShutdown, MAX_PROMPT_CHARS, type ServerDeps } from "../src/server.js";
import { defaultReply, FakeAppServer, fakeModel, threadStartResult, type Msg } from "./fake-app-server.js";
import { nodeScript, writeExec } from "./fake-cli.js";

const FULL: ImageProtocolCapabilities = { nativeInstructions: true, continuity: true, resumeExcludeTurns: true, setName: true, localImageInput: false, reason: null };
const okProbe = async () => ({ ok: true, stdout: "codex-cli 0.156.0\n" });
const caps = async () => ({
  plugins: { available: false, reason: "x", items: [], truncated: false, has_more: null },
  mcp_servers: { available: false, reason: "x", items: [], truncated: false, has_more: null },
});
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-sess-")));
const png = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, n)]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const imageItem = (threadId: string | undefined, turnId: string | undefined, savedPath: string | null): object => ({
  method: "item/completed",
  params: { threadId, turnId, item: { type: "imageGeneration", id: `g_${turnId}`, result: "", status: "completed", savedPath } },
});
const turnDone = (threadId: string, turnId: string, status = "completed"): object => ({
  method: "turn/completed",
  params: { threadId, turn: { id: turnId, items: [], status, error: null } },
});

/** One completed fixture turn as the fake peer "persists" it in its thread history. */
interface FixtureTurn {
  turn: string;
  prompt: string;
  savedPath: string | null;
}

/**
 * Scripted multi-job Codex peer: one FakeAppServer per job, shared "persisted"
 * per-thread fixture history. A turn/start may only target a thread loaded in
 * the same process (by thread/start or thread/resume), and records the prior
 * history it would see as context. This models protocol continuity only; it
 * says nothing about what a live model does with that context.
 */
interface World {
  base: string;
  home: string;
  out: string;
  servers: FakeAppServer[];
  model: string;
  threads: Map<string, FixtureTurn[]>;
  /** Per turn id: thread and the prior fixture history available to it. */
  contexts: Map<string, { threadId: string; prior: FixtureTurn[] }>;
  loaded: WeakMap<FakeAppServer, Set<string>>;
  threadSeq: number;
  turnSeq: number;
  /** Image bytes written per turn number. */
  images: Map<string, Buffer>;
  hold: boolean;
  held: (() => void)[];
  /** Return a reply to override the default; undefined keeps the default. */
  override?: (msg: Msg, ctx: FakeAppServer) => unknown;
  /** Sent synchronously before the turn/start response (early events). */
  beforeTurnReply?: (ctx: FakeAppServer, threadId: string, turnId: string) => void;
  /** savedPath for a turn (default: a fresh PNG under the Codex home). */
  savedFor?: (turnId: string) => string | null;
  /** Skip the post-reply image item (early-event tests send their own). */
  skipImage: boolean;
}

function loadedIn(w: World, ctx: FakeAppServer): Set<string> {
  let s = w.loaded.get(ctx);
  if (!s) w.loaded.set(ctx, (s = new Set()));
  return s;
}

function reply(w: World, msg: Msg, ctx: FakeAppServer): unknown {
  // A resume of a known thread loads it even when a test overrides the response shape.
  if (msg.method === "thread/resume" && w.threads.has(msg.params?.threadId as string)) loadedIn(w, ctx).add(msg.params!.threadId as string);
  const o = w.override?.(msg, ctx);
  if (o !== undefined) return o === "NO_REPLY" ? undefined : o;
  const p = msg.params ?? {};
  switch (msg.method) {
    case "model/list":
      return { result: { data: [fakeModel("other-model", false), fakeModel(w.model, true)], nextCursor: null } };
    case "thread/start": {
      const id = `thr_${++w.threadSeq}`;
      w.threads.set(id, []);
      loadedIn(w, ctx).add(id);
      const r = threadStartResult(p.cwd, { model: p.model });
      (r.thread as Record<string, unknown>).id = id;
      return { result: r };
    }
    case "thread/resume": {
      const id = p.threadId as string;
      if (!w.threads.has(id)) return { error: { code: -32600, message: `thread not found: ${id}` } };
      loadedIn(w, ctx).add(id);
      const r = threadStartResult(p.cwd, { model: p.model });
      (r.thread as Record<string, unknown>).id = id;
      return { result: r };
    }
    case "turn/start": {
      const thr = p.threadId as string;
      const history = w.threads.get(thr);
      if (!history || !loadedIn(w, ctx).has(thr)) return { error: { code: -32600, message: `thread not loaded: ${thr}` } };
      const turn = `turn_${++w.turnSeq}`;
      let saved: string | null;
      if (w.savedFor) saved = w.savedFor(turn);
      else {
        const bytes = png(w.turnSeq);
        saved = path.join(w.home, "generated_images", `${turn}.png`);
        writeFileSync(saved, bytes);
        w.images.set(turn, bytes);
      }
      w.contexts.set(turn, { threadId: thr, prior: history.map((h) => ({ ...h })) });
      const text = (p.input as Any[] | undefined)?.[0]?.text;
      history.push({ turn, prompt: typeof text === "string" ? text : "", savedPath: saved });
      w.beforeTurnReply?.(ctx, thr, turn);
      const finish = (): void => {
        if (!w.skipImage) ctx.send(imageItem(thr, turn, saved));
        ctx.send(turnDone(thr, turn));
      };
      if (w.hold) w.held.push(finish);
      else setTimeout(finish, 1);
      return { result: { turn: { id: turn, items: [], status: "inProgress" } } };
    }
    default:
      return defaultReply(msg);
  }
}

function world(extra: Partial<ServerDeps> = {}, env: Record<string, string> = {}): { w: World; deps: ServerDeps } {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const w: World = {
    base,
    home,
    out: path.join(base, "out"),
    servers: [],
    model: "advertised-default",
    threads: new Map(),
    contexts: new Map(),
    loaded: new WeakMap(),
    threadSeq: 0,
    turnSeq: 0,
    images: new Map(),
    hold: false,
    held: [],
    skipImage: false,
  };
  const deps: ServerDeps = {
    versionProbe: okProbe,
    capabilityProbe: caps,
    wallMs: 5_000,
    env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: w.out, CODEX_BIN: "/fake/bin/codex", ...env },
    imageCapabilities: async () => FULL,
    createTransport: () => {
      const s = new FakeAppServer({ onRequest: (m, c) => reply(w, m, c) });
      w.servers.push(s);
      return s;
    },
    ...extra,
  };
  return { w, deps };
}

const sent = (w: World, method: string): Msg[] => w.servers.flatMap((s) => s.received.filter((m) => m.method === method));

type Any = Record<string, any>;

async function connect(deps: ServerDeps) {
  const { server, handler } = buildServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "image-session-test", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: unknown): Promise<Any> => {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    return { ...(r.structuredContent as Any), isError: r.isError === true };
  };
  const done = async (id: string): Promise<Any> => {
    for (let i = 0; i < 400; i++) {
      const r = await call("codex_task_status", { job_id: id });
      if (r.state !== "running") return r;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("job did not finish");
  };
  /** Starts an image job and waits for it. */
  const gen = async (args: Any): Promise<{ start: Any; end: Any }> => {
    const start = await call("codex_image_generate", args);
    assert.equal(start.isError, false, JSON.stringify(start));
    return { start, end: await done(start.job_id) };
  };
  return { handler, call, done, gen, close: () => client.close() };
}

test("new then same-thread second turn: thread/resume of the bridge-owned id, raw edit prompt, current-turn image only", async () => {
  const { w, deps } = world();
  const m = await connect(deps);
  const first = await m.gen({ prompt: "a red fox in snow", cwd: w.base });
  assert.equal(first.end.state, "succeeded");
  const handle = first.start.session_handle as string;
  assert.ok(isSessionHandleShape(handle));
  assert.equal(first.end.result.session_handle, handle);
  assert.equal(first.start.session.turns_used, 1);
  assert.equal(first.end.result.session.continued, false);
  assert.equal(first.end.session.next_action, "reuse_only_for_related_edits");

  // First turn: native developer instructions + fixed name; the visible prompt is the user's own text.
  const ts = sent(w, "thread/start");
  assert.equal(ts.length, 1);
  assert.equal(ts[0]!.params!.developerInstructions, IMAGE_DEVELOPER_INSTRUCTIONS);
  assert.deepEqual(sent(w, "thread/name/set")[0]!.params, { threadId: "thr_1", name: IMAGE_THREAD_NAME });
  assert.equal(sent(w, "thread/setName").length, 0);
  assert.deepEqual((sent(w, "turn/start")[0]!.params!.input as Any[])[0]!.text, "a red fox in snow");

  const second = await m.gen({ prompt: "make the fox blue", cwd: w.base, session_handle: handle });
  assert.equal(second.end.state, "succeeded", JSON.stringify(second.end.error));
  assert.equal(second.end.result.session_handle, handle);
  assert.equal(second.end.result.session.turns_used, 2);
  assert.equal(second.end.result.session.continued, true);
  assert.equal(second.end.result.session.previous_job_id, first.start.job_id);
  assert.equal(second.end.result.session.prompt_chars_used, "a red fox in snow".length + "make the fox blue".length);

  // Second process: no new thread; resume of the recorded id with the same explicit policy and instructions.
  assert.equal(w.servers.length, 2);
  assert.deepEqual(w.servers[1]!.methods(), ["initialize", "initialized", "model/list", "thread/resume", "turn/start"]);
  const rs = sent(w, "thread/resume")[0]!.params!;
  assert.deepEqual(rs, {
    threadId: "thr_1",
    cwd: w.base,
    model: "advertised-default",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    developerInstructions: IMAGE_DEVELOPER_INSTRUCTIONS,
    excludeTurns: true,
  });
  const t2 = sent(w, "turn/start")[1]!.params!;
  assert.equal(t2.threadId, "thr_1");
  assert.deepEqual(t2.input, [{ type: "text", text: "make the fox blue", text_elements: [] }]);
  assert.deepEqual(t2.sandboxPolicy, { type: "workspaceWrite", writableRoots: [w.base], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
  // Fixture continuity only (no live edit): the edit turn ran on the resumed thread whose
  // fixture history holds the first turn's native savedPath and prompt; the first turn saw none.
  const firstSaved = path.join(w.home, "generated_images", "turn_1.png");
  assert.deepEqual(w.contexts.get("turn_1"), { threadId: "thr_1", prior: [] });
  assert.deepEqual(w.contexts.get("turn_2"), { threadId: "thr_1", prior: [{ turn: "turn_1", prompt: "a red fox in snow", savedPath: firstSaved }] });

  // Output paths: each job its own owned UUID dir; the second holds only the second turn's image.
  const f1 = first.end.result.files;
  const f2 = second.end.result.files;
  assert.equal(f1.length, 1);
  assert.equal(f2.length, 1);
  assert.equal(f2[0].sha256, sha(w.images.get("turn_2")!));
  assert.notEqual(path.dirname(f1[0].path), path.dirname(f2[0].path));
  assert.match(path.relative(w.out, f2[0].path), /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(readFileSync(f2[0].path), w.images.get("turn_2"));

  // The native thread id never reaches the MCP caller.
  for (const r of [first.start, first.end, second.start, second.end]) assert.ok(!JSON.stringify(r).includes("thr_"));
  await m.close();
});

test("only events of the current thread+turn count, including early ones; prior-turn, unnamed and other-thread events are discarded", async () => {
  const { w, deps } = world();
  const m = await connect(deps);
  const first = await m.gen({ prompt: "a lighthouse", cwd: w.base });
  const old = path.join(w.home, "generated_images", "turn_1.png");
  w.skipImage = true;
  w.beforeTurnReply = (ctx, thr, turn) => {
    ctx.send(imageItem(thr, "turn_1", old)); // prior turn of the same thread
    ctx.send(turnDone(thr, "turn_1", "failed")); // prior completion must not complete or fail this turn
    ctx.send(imageItem(thr, undefined, old)); // no turn id
    ctx.send(imageItem(undefined, turn, old)); // no thread id
    ctx.send(imageItem("thr_other", turn, old)); // another thread
    ctx.send(imageItem(thr, turn, path.join(w.home, "generated_images", `${turn}.png`))); // current, before turn/start response
  };
  // A resume response that (wrongly) carries history is never read for outputs.
  w.override = (msg) => {
    if (msg.method !== "thread/resume") return undefined;
    const r = threadStartResult(msg.params!.cwd, { model: msg.params!.model });
    Object.assign(r.thread as Any, { id: msg.params!.threadId, turns: [{ id: "turn_1", status: "completed", items: [{ type: "imageGeneration", savedPath: old, status: "completed" }] }] });
    return { result: r };
  };
  const second = await m.gen({ prompt: "at night", cwd: w.base, session_handle: first.start.session_handle });
  assert.equal(second.end.state, "succeeded", JSON.stringify(second.end.error));
  assert.equal(second.end.result.files.length, 1);
  assert.equal(second.end.result.files[0].sha256, sha(w.images.get("turn_2")!));
  await m.close();
});

test("fresh_session resets the passed handle and starts a new thread; no handle is always a new thread", async () => {
  const { w, deps } = world();
  const m = await connect(deps);
  const a = await m.gen({ prompt: "a cat", cwd: w.base });
  const h1 = a.start.session_handle;
  const b = await m.gen({ prompt: "a dog", cwd: w.base, session_handle: h1, fresh_session: true });
  const h2 = b.start.session_handle;
  assert.equal(b.end.state, "succeeded");
  assert.notEqual(h2, h1);
  assert.equal(b.end.result.session.turns_used, 1);
  assert.equal(b.end.result.session.continued, false);
  const c = await m.gen({ prompt: "unrelated bird", cwd: w.base });
  assert.notEqual(c.start.session_handle, h2);
  assert.equal(sent(w, "thread/start").length, 3);
  assert.equal(sent(w, "thread/resume").length, 0);
  // The reset handle is revoked; fresh_session without a handle is also a new thread.
  const reuse = await m.call("codex_image_generate", { prompt: "x", cwd: w.base, session_handle: h1 });
  assert.equal(reuse.error.code, "SESSION_INVALIDATED");
  assert.equal(reuse.error.detail, "reset");
  assert.equal(reuse.error.action, "fresh_session_required");
  const d = await m.gen({ prompt: "fresh", cwd: w.base, fresh_session: true });
  assert.equal(d.end.state, "succeeded");
  assert.equal(sent(w, "thread/start").length, 4);
  // h2 still continues its own thread.
  const e = await m.gen({ prompt: "dog with a hat", cwd: w.base, session_handle: h2 });
  assert.equal(e.end.state, "succeeded");
  assert.equal(sent(w, "thread/resume")[0]!.params!.threadId, "thr_2");
  // Fixture context: fresh and unrelated threads start empty; the edit sees only its own thread's history.
  assert.deepEqual(w.contexts.get("turn_2"), { threadId: "thr_2", prior: [] });
  assert.deepEqual(w.contexts.get("turn_3"), { threadId: "thr_3", prior: [] });
  assert.deepEqual(w.contexts.get("turn_4"), { threadId: "thr_4", prior: [] });
  assert.deepEqual(w.contexts.get("turn_5"), {
    threadId: "thr_2",
    prior: [{ turn: "turn_2", prompt: "a dog", savedPath: path.join(w.home, "generated_images", "turn_2.png") }],
  });
  await m.close();
});

test("raw arbitrary ids are rejected; unknown and cross-handler handles fail before any spawn or job", async () => {
  const one = world();
  const two = world();
  const a = await connect(one.deps);
  const b = await connect(two.deps);
  const g = await a.gen({ prompt: "a tree", cwd: one.w.base });
  const handle = g.start.session_handle;
  const spawnedB = two.w.servers.length;
  for (const bad of ["thr_1", "019a-native-thread-id", "cis_short", `${handle}x`, "", 5, null]) {
    const r = await b.call("codex_image_generate", { prompt: "x", cwd: two.w.base, session_handle: bad });
    assert.equal(r.error.code, "INVALID_ARGUMENTS", String(bad));
  }
  const unknown = `cis_${"A".repeat(32)}`;
  for (const args of [{ session_handle: handle }, { session_handle: unknown }, { session_handle: unknown, fresh_session: true }]) {
    const r = await b.call("codex_image_generate", { prompt: "x", cwd: two.w.base, ...args });
    assert.equal(r.error.code, "SESSION_UNKNOWN");
    // Recovery is to omit the handle: fresh_session with an unknown handle is rejected too.
    assert.equal(r.error.action, "omit_session_handle");
  }
  assert.equal(two.w.servers.length, spawnedB);
  assert.equal(b.handler.jobs.active, undefined);
  const bad = await a.call("codex_image_generate", { prompt: "x", cwd: one.w.base, fresh_session: "yes" });
  assert.equal(bad.isError, true);
  await a.close();
  await b.close();
});

test("idle expiry, max turns and cumulative prompt chars require an explicit fresh session; nothing is spawned", async () => {
  let now = 1_000_000;
  const { w, deps } = world({ now: () => now });
  const m = await connect(deps);
  const h = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
  const rollover = (handle: string, reason: string) => ({ session_handle: handle, usable: false, revoked_reason: null, rollover_reason: reason, next_action: "fresh_session_required" });
  let last: Any = {};
  for (let i = 1; i < SESSION_LIMITS.maxTurns; i++) {
    last = (await m.gen({ prompt: "edit", cwd: w.base, session_handle: h })).end;
    assert.equal(last.state, "succeeded");
    if (i === SESSION_LIMITS.maxTurns - 2) assert.equal(last.session.usable, true);
  }
  // The poll at the exhausted turn budget already reports what the next call enforces.
  assert.deepEqual(last.session, rollover(h, "max_turns"));
  const spawned = w.servers.length;
  const turns = sent(w, "turn/start").length;
  const r = await m.call("codex_image_generate", { prompt: "one more", cwd: w.base, session_handle: h });
  assert.equal(r.error.code, "SESSION_ROLLOVER_REQUIRED");
  assert.equal(r.error.detail, "max_turns");
  assert.equal(r.error.action, "fresh_session_required");
  assert.equal(w.servers.length, spawned);
  assert.equal(sent(w, "turn/start").length, turns);
  assert.deepEqual((await m.call("codex_task_status", { job_id: last.job_id })).session, rollover(h, "max_turns"));
  const fresh = await m.gen({ prompt: "self-contained description", cwd: w.base, session_handle: h, fresh_session: true });
  assert.equal(fresh.end.state, "succeeded");
  assert.equal(fresh.end.result.session.continued, false);
  assert.equal(fresh.end.session.usable, true);
  assert.equal(fresh.end.session.rollover_reason, null);

  const big = "x".repeat(MAX_PROMPT_CHARS);
  const h2 = (await m.gen({ prompt: big, cwd: w.base })).start.session_handle;
  let lastBig: Any = {};
  for (let i = 1; i < SESSION_LIMITS.maxPromptChars / MAX_PROMPT_CHARS; i++) lastBig = (await m.gen({ prompt: big, cwd: w.base, session_handle: h2 })).end;
  assert.equal(lastBig.result.session.prompt_chars_used, SESSION_LIMITS.maxPromptChars);
  assert.ok(lastBig.result.session.turns_used < SESSION_LIMITS.maxTurns);
  assert.deepEqual(lastBig.session, rollover(h2, "max_prompt_chars"));
  const spawned2 = w.servers.length;
  const turns2 = sent(w, "turn/start").length;
  const c = await m.call("codex_image_generate", { prompt: "y", cwd: w.base, session_handle: h2 });
  assert.equal(c.error.code, "SESSION_ROLLOVER_REQUIRED");
  assert.equal(c.error.detail, "max_prompt_chars");
  assert.equal(w.servers.length, spawned2);
  assert.equal(sent(w, "turn/start").length, turns2);
  const fresh2 = await m.gen({ prompt: "self-contained description", cwd: w.base, session_handle: h2, fresh_session: true });
  assert.equal(fresh2.end.state, "succeeded");
  assert.equal(fresh2.end.session.usable, true);
  assert.equal(fresh2.end.session.rollover_reason, null);

  const h3 = (await m.gen({ prompt: "q", cwd: w.base })).start.session_handle;
  now += SESSION_LIMITS.idleTtlMs + 1;
  const e = await m.call("codex_image_generate", { prompt: "edit", cwd: w.base, session_handle: h3 });
  assert.equal(e.error.code, "SESSION_EXPIRED");
  assert.equal(w.servers.length, spawned2 + 2);
  // Recovery is explicit: the same handle with fresh_session starts a new thread.
  const f = await m.gen({ prompt: "self-contained description", cwd: w.base, session_handle: h3, fresh_session: true });
  assert.equal(f.end.state, "succeeded");
  await m.close();
});

test("cwd mismatch is rejected before spawn; model change and policy drift fail closed without any turn", async () => {
  const { w, deps } = world();
  const m = await connect(deps);
  const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-sess-cwd-")));
  const h = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
  const spawned = w.servers.length;
  const r = await m.call("codex_image_generate", { prompt: "edit", cwd: other, session_handle: h });
  assert.equal(r.error.code, "SESSION_INCOMPATIBLE");
  assert.equal(r.error.detail, "cwd");
  assert.equal(w.servers.length, spawned);

  // The advertised default model changed: reject rather than continue in the wrong context.
  w.model = "new-default";
  const mm = await m.gen({ prompt: "edit", cwd: w.base, session_handle: h });
  assert.equal(mm.end.state, "failed");
  assert.equal(mm.end.error.code, "SESSION_INCOMPATIBLE");
  assert.deepEqual(mm.end.error.diagnostic, { phase: "model_select", session_mismatch: "model" });
  assert.equal(sent(w, "thread/resume").length, 0);
  assert.equal(sent(w, "turn/start").length, 1);
  assert.equal(mm.end.session.next_action, "fresh_session_required");
  assert.equal((await m.call("codex_image_generate", { prompt: "e", cwd: w.base, session_handle: h })).error.code, "SESSION_INVALIDATED");

  w.model = "advertised-default";
  const h2 = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
  w.override = (msg) => {
    if (msg.method !== "thread/resume") return undefined;
    const r2 = threadStartResult(msg.params!.cwd, { model: msg.params!.model }, { writableRoots: [w.base, "/elsewhere"] });
    (r2.thread as Any).id = msg.params!.threadId;
    return { result: r2 };
  };
  const pd = await m.gen({ prompt: "edit", cwd: w.base, session_handle: h2 });
  assert.equal(pd.end.error.code, "POLICY_MISMATCH");
  assert.equal(pd.end.error.diagnostic.policy_mismatch, "writable_roots");
  assert.equal(sent(w, "turn/start").length, 2);
  await m.close();
});

test("stale or misidentified resumed threads fail with SESSION_STALE / SESSION_INCOMPATIBLE before any turn", async () => {
  for (const [label, override, code, mismatch] of [
    ["missing thread", (w: World) => () => (w.threads.clear(), undefined), "SESSION_STALE", undefined],
    ["other thread id", () => (msg: Msg) => (msg.method === "thread/resume" ? { result: { ...threadStartResult(msg.params!.cwd, { model: msg.params!.model }) , thread: { ...(threadStartResult(msg.params!.cwd).thread as Any), id: "thr_999" } } } : undefined), "SESSION_STALE", "thread_id"],
    ["other model", () => (msg: Msg) => (msg.method === "thread/resume" ? { result: { ...threadStartResult(msg.params!.cwd, { model: "drifted" }), thread: { ...(threadStartResult(msg.params!.cwd).thread as Any), id: msg.params!.threadId } } } : undefined), "SESSION_INCOMPATIBLE", "model"],
    ["no thread", () => (msg: Msg) => (msg.method === "thread/resume" ? { result: {} } : undefined), "PROTOCOL_ERROR", undefined],
  ] as const) {
    const { w, deps } = world();
    const m = await connect(deps);
    const h = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
    w.override = (override as (w: World) => (msg: Msg) => unknown)(w);
    const r = await m.gen({ prompt: "edit", cwd: w.base, session_handle: h });
    assert.equal(r.end.state, "failed", label);
    assert.equal(r.end.error.code, code, label);
    if (mismatch) assert.equal(r.end.error.diagnostic.session_mismatch, mismatch, label);
    assert.equal(sent(w, "turn/start").length, 1, `${label}: no second turn`);
    assert.equal((await m.call("codex_image_generate", { prompt: "e", cwd: w.base, session_handle: h })).error.code, "SESSION_INVALIDATED", label);
    await m.close();
  }
});

test("BUSY neither consumes nor revokes a handle; the held continuation then succeeds", async () => {
  const { w, deps } = world();
  const m = await connect(deps);
  const h = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
  w.hold = true;
  const s = await m.call("codex_image_generate", { prompt: "edit", cwd: w.base, session_handle: h });
  for (let i = 0; i < 100 && w.held.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  for (const args of [{ session_handle: h }, { session_handle: h, fresh_session: true }, {}]) {
    const r = await m.call("codex_image_generate", { prompt: "again", cwd: w.base, ...args });
    assert.equal(r.error.code, "BUSY");
  }
  w.held.shift()!();
  const end = await m.done(s.job_id);
  assert.equal(end.state, "succeeded");
  assert.equal(end.result.session.turns_used, 2);
  w.hold = false;
  assert.equal((await m.gen({ prompt: "edit 2", cwd: w.base, session_handle: h })).end.state, "succeeded");
  await m.close();
});

test("cancel, timeout and shutdown invalidate the handle; nothing is retried", async () => {
  for (const how of ["cancel", "timeout", "shutdown"] as const) {
    const { w, deps } = world(how === "timeout" ? { wallMs: 300 } : {});
    const m = await connect(deps);
    const h = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
    w.hold = true;
    const s = await m.call("codex_image_generate", { prompt: "edit", cwd: w.base, session_handle: h });
    for (let i = 0; i < 100 && w.held.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    if (how === "cancel") assert.equal((await m.call("codex_task_cancel", { job_id: s.job_id })).cancel_requested, true);
    if (how === "shutdown") await makeShutdown(m.handler.jobs, async () => undefined, 2_000)();
    const end = await m.done(s.job_id);
    assert.equal(end.error.code, how === "timeout" ? "TIMEOUT" : "CANCELLED", how);
    assert.deepEqual(end.session, { session_handle: h, usable: false, revoked_reason: "invalidated", rollover_reason: null, next_action: "fresh_session_required" });
    assert.equal(sent(w, "turn/start").length, 2, how);
    assert.ok(sent(w, "turn/interrupt").length >= 1, how);
    const again = await m.call("codex_image_generate", { prompt: "edit", cwd: w.base, session_handle: h });
    assert.equal(again.error.code, "SESSION_INVALIDATED", how);
    await m.close();
  }
});

test("uncertain failures and output failures invalidate the handle without any retry", async () => {
  const cases: [string, (w: World) => void, string][] = [
    ["process exit mid-turn", (w) => (w.override = (msg, ctx) => (msg.method === "turn/start" ? (setTimeout(() => ctx.exit(), 1), { result: { turn: { id: "turn_x", items: [], status: "inProgress" } } }) : undefined)), "PROCESS_EXITED"],
    ["turn/start error", (w) => (w.override = (msg) => (msg.method === "turn/start" ? { error: { code: -32603, message: "boom" } } : undefined)), "TURN_START_FAILED"],
    ["turn failed", (w) => (w.override = (msg, ctx) => (msg.method === "turn/start" ? (setTimeout(() => ctx.send(turnDone(msg.params!.threadId as string, "turn_f", "failed")), 1), { result: { turn: { id: "turn_f", items: [], status: "inProgress" } } }) : undefined)), "TURN_FAILED"],
    ["unverifiable image", (w) => (w.savedFor = () => { const p = path.join(w.base, "outside.png"); writeFileSync(p, png(9)); return p; }), "IMAGE_VERIFICATION_FAILED"],
    ["no image", (w) => (w.skipImage = true), "NO_IMAGE_PRODUCED"],
  ];
  for (const [label, arm, code] of cases) {
    const { w, deps } = world();
    const m = await connect(deps);
    const h = (await m.gen({ prompt: "p", cwd: w.base })).start.session_handle;
    const before = readdirSync(w.out);
    arm(w);
    const r = await m.gen({ prompt: "edit", cwd: w.base, session_handle: h });
    assert.equal(r.end.error.code, code, label);
    assert.equal(sent(w, "turn/start").length, 2, `${label}: exactly one billed attempt`);
    assert.equal(w.servers.length, 2, `${label}: no new process`);
    assert.deepEqual(readdirSync(w.out), before, `${label}: owned output removed`);
    assert.equal((await m.call("codex_image_generate", { prompt: "e", cwd: w.base, session_handle: h })).error.code, "SESSION_INVALIDATED", label);
    await m.close();
  }
});

test("thread/name/set: method-not-found is skipped; any other error fails the job before a turn", async () => {
  for (const [err, ok] of [[{ code: -32601, message: "method not found" }, true], [{ code: -32603, message: "internal" }, false]] as const) {
    const { w, deps } = world();
    w.override = (msg) => (msg.method === "thread/name/set" ? { error: err } : undefined);
    const m = await connect(deps);
    const r = await m.gen({ prompt: "p", cwd: w.base });
    assert.equal(r.end.state, ok ? "succeeded" : "failed");
    if (!ok) {
      assert.equal(r.end.error.code, "THREAD_START_FAILED");
      assert.equal(r.end.error.diagnostic.phase, "thread_name");
      assert.equal(sent(w, "turn/start").length, 0);
    }
    await m.close();
  }
});

test("thread/start reporting a different model than requested fails closed for image threads", async () => {
  const { w, deps } = world();
  w.override = (msg) => (msg.method === "thread/start" ? { result: threadStartResult(msg.params!.cwd, { model: "something-else" }) } : undefined);
  const m = await connect(deps);
  const r = await m.gen({ prompt: "p", cwd: w.base });
  assert.equal(r.end.error.code, "POLICY_MISMATCH");
  assert.equal(r.end.error.diagnostic.policy_mismatch, "model");
  assert.equal(sent(w, "turn/start").length, 0);
  await m.close();
});

test("without continuity support: prompt-wrapper or native-instruction fallback, null handle, handles rejected", async () => {
  for (const c of [
    { nativeInstructions: false, continuity: false, resumeExcludeTurns: false, setName: false, localImageInput: false, reason: "no_thread_start_instructions" },
    { nativeInstructions: true, continuity: false, resumeExcludeTurns: false, setName: false, localImageInput: false, reason: "no_thread_resume" },
  ] as ImageProtocolCapabilities[]) {
    const { w, deps } = world({ imageCapabilities: async () => c });
    const m = await connect(deps);
    const r = await m.gen({ prompt: "a boat", cwd: w.base });
    assert.equal(r.end.state, "succeeded");
    assert.equal(r.start.session_handle, null);
    assert.deepEqual(r.end.result.session, { continuity: "unavailable", reason: c.reason });
    const ts = sent(w, "thread/start")[0]!.params!;
    const text = (sent(w, "turn/start")[0]!.params!.input as Any[])[0]!.text as string;
    if (c.nativeInstructions) {
      assert.equal(ts.developerInstructions, IMAGE_DEVELOPER_INSTRUCTIONS);
      assert.equal(text, "a boat");
    } else {
      assert.equal("developerInstructions" in ts, false);
      assert.ok(text.startsWith("Generate exactly one image") && text.endsWith("a boat"));
    }
    assert.equal(sent(w, "thread/name/set").length, 0);
    const h = await m.call("codex_image_generate", { prompt: "x", cwd: w.base, session_handle: `cis_${"B".repeat(32)}` });
    assert.equal(h.error.code, "SESSION_UNKNOWN");

    // Fallback jobs are strict too: foreign, prior and unnamed events are ignored, early current ones kept.
    const old = path.join(w.home, "generated_images", "turn_1.png");
    w.skipImage = true;
    let current = true;
    w.beforeTurnReply = (ctx, thr, turn) => {
      ctx.send(imageItem(thr, "turn_1", old));
      ctx.send(turnDone(thr, "turn_1", "failed"));
      ctx.send(imageItem(thr, undefined, old));
      ctx.send(imageItem(undefined, turn, old));
      ctx.send(imageItem("thr_other", turn, old));
      ctx.send(turnDone("thr_other", turn, "failed"));
      if (current) ctx.send(imageItem(thr, turn, path.join(w.home, "generated_images", `${turn}.png`)));
    };
    const f = await m.gen({ prompt: "a ship", cwd: w.base });
    assert.equal(f.end.state, "succeeded", `${c.reason}: ${JSON.stringify(f.end.error)}`);
    assert.equal(f.end.result.files.length, 1);
    assert.equal(f.end.result.files[0].sha256, sha(w.images.get("turn_2")!));
    // No current-turn image: foreign/prior items never stand in for it; the owned output dir is removed.
    current = false;
    const before = readdirSync(w.out).sort();
    const g = await m.gen({ prompt: "a plane", cwd: w.base });
    assert.equal(g.end.state, "failed");
    assert.equal(g.end.error.code, "NO_IMAGE_PRODUCED");
    assert.deepEqual(readdirSync(w.out).sort(), before);
    await m.close();
  }
});

test("general tasks stay new-thread with no instructions/resume/naming; image-only hides codex_task_start; capabilities discovered once", async () => {
  let discovered = 0;
  const { w, deps } = world({ imageCapabilities: async () => (discovered++, FULL) });
  const m = await connect(deps);
  w.skipImage = true;
  const t = await m.call("codex_task_start", { prompt: "do it", cwd: w.base });
  assert.equal((await m.done(t.job_id)).state, "succeeded");
  assert.equal(discovered, 0, "tasks never discover");
  assert.equal("developerInstructions" in sent(w, "thread/start")[0]!.params!, false);
  assert.equal((sent(w, "turn/start")[0]!.params!.input as Any[])[0]!.text, "do it");
  assert.equal(sent(w, "thread/name/set").length, 0);
  assert.equal(t.session_handle, undefined);
  w.skipImage = false;
  await m.gen({ prompt: "a", cwd: w.base });
  await m.gen({ prompt: "b", cwd: w.base });
  assert.equal(discovered, 1);
  assert.equal(sent(w, "thread/resume").length, 0);
  const st = await m.call("codex_status", {});
  assert.equal(st.image_sessions.continuity, "available");
  assert.equal(st.image_sessions.retained, 2);
  await m.close();

  const io = world({}, { CODEX_BRIDGE_MODE: "image-only" });
  const n = await connect(io.deps);
  const r = await n.call("codex_task_start", { prompt: "x", cwd: io.w.base });
  assert.equal(r.error.code, "TOOL_DISABLED");
  assert.equal(io.w.servers.length, 0);
  const g = await n.gen({ prompt: "img", cwd: io.w.base });
  assert.equal((await n.gen({ prompt: "edit", cwd: io.w.base, session_handle: g.start.session_handle })).end.state, "succeeded");
  await n.close();
});

const CTX: SessionContext = { cwd: "/a", mode: "general", outputRoot: "/o", launcher: "/bin/codex", policy: "p" };

test("session store: retained cap evicts least recently used; incompatible context fields; unissued leases leave no trace", () => {
  let now = 0;
  const s = new ImageSessionStore(() => now);
  const made = [];
  for (let i = 0; i <= SESSION_LIMITS.maxSessions; i++) {
    now++;
    const x = s.create(CTX);
    s.lease(x);
    s.succeed(x, `t${i}`, "m", 1, `j${i}`);
    made.push(x.handle);
  }
  assert.equal(s.size, SESSION_LIMITS.maxSessions);
  assert.deepEqual(s.check(made[0]!, CTX, 1), { code: "SESSION_EXPIRED", detail: "evicted" });
  assert.equal(new Set(made).size, made.length);
  for (const k of ["cwd", "mode", "outputRoot", "launcher", "policy"] as const) {
    assert.deepEqual(s.check(made[1]!, { ...CTX, [k]: "/different" }, 1), { code: "SESSION_INCOMPATIBLE", detail: k });
  }
  const pending = s.create(CTX);
  s.lease(pending);
  assert.deepEqual(s.check(pending.handle, CTX, 1), { code: "SESSION_INVALIDATED", detail: "invalidated" });
  s.release(pending);
  assert.equal(s.owns(pending.handle), false);
  const live = s.check(made[2]!, CTX, 1) as { threadId: string };
  assert.equal(live.threadId, "t2");
  assert.ok(!isSessionHandleShape("t2"));
});

test("capability discovery: methods come from the ClientRequest union, params from its schema; missing pieces fail closed", async () => {
  const v = (method: string, params: object): object => ({ type: "object", properties: { id: { type: "integer" }, method: { type: "string", enum: [method] }, params } });
  const defs = {
    v2: {
      ThreadStartParams: { type: "object", properties: { cwd: { type: ["string", "null"] }, developerInstructions: { type: ["string", "null"] }, model: { type: ["string", "null"] } } },
      ThreadResumeParams: {
        type: "object",
        properties: Object.fromEntries(
          ["threadId", "cwd", "model", "approvalPolicy", "approvalsReviewer", "sandbox"]
            .map((k) => [k, {}])
            .concat([["excludeTurns", { type: "boolean" }], ["developerInstructions", { type: ["string", "null"] }]]),
        ),
      },
      TurnStartParams: { type: "object", properties: Object.fromEntries(["threadId", "input", "cwd", "approvalPolicy", "approvalsReviewer", "sandboxPolicy"].map((k) => [k, {}])) },
    },
  };
  const union = (extra: object[] = []): object => ({
    oneOf: [
      v("thread/start", { $ref: "#/definitions/v2/ThreadStartParams" }),
      v("thread/resume", { $ref: "#/definitions/v2/ThreadResumeParams" }),
      v("turn/start", { $ref: "#/definitions/v2/TurnStartParams" }),
      ...extra,
    ],
    definitions: defs,
  });
  const full = capabilitiesFromMethods(
    await methodsFromClientRequest(union([v("thread/name/set", { $ref: "#/definitions/v2/ThreadSetNameParams" })]), async (n) =>
      n === "ThreadSetNameParams" ? { type: "object", properties: { threadId: { type: "string" }, name: { type: "string" } } } : null,
    ),
  );
  assert.deepEqual(full, FULL);
  // Typed fields fail closed when untyped or incompatibly typed.
  const untypedInstr = structuredClone(union()) as Any;
  untypedInstr.definitions.v2.ThreadStartParams.properties.developerInstructions = {};
  assert.equal(capabilitiesFromMethods(await methodsFromClientRequest(untypedInstr)).reason, "no_thread_start_instructions");
  const untypedResumeInstr = structuredClone(union()) as Any;
  untypedResumeInstr.definitions.v2.ThreadResumeParams.properties.developerInstructions = {};
  assert.equal(capabilitiesFromMethods(await methodsFromClientRequest(untypedResumeInstr)).reason, "resume_params_missing");
  const badExclude = structuredClone(union()) as Any;
  badExclude.definitions.v2.ThreadResumeParams.properties.excludeTurns = { type: "string" };
  assert.equal(capabilitiesFromMethods(await methodsFromClientRequest(badExclude)).resumeExcludeTurns, false);
  for (const props of [{ threadId: { type: "string" }, name: {} }, { threadId: {}, name: { type: "string" } }, { threadId: { type: "string" }, name: { type: "boolean" } }]) {
    const t = await methodsFromClientRequest(union([v("thread/name/set", { type: "object", properties: props })]));
    assert.equal(capabilitiesFromMethods(t).setName, false, JSON.stringify(props));
  }
  // A params definition alone (file present, method absent from the union) is not support.
  const noResume = { ...(union() as Any), oneOf: (union() as Any).oneOf.filter((x: Any) => x.properties.method.enum[0] !== "thread/resume") };
  assert.equal(capabilitiesFromMethods(await methodsFromClientRequest(noResume)).reason, "no_thread_resume");
  const noInstr = structuredClone(union()) as Any;
  delete noInstr.definitions.v2.ThreadStartParams.properties.developerInstructions;
  assert.deepEqual(capabilitiesFromMethods(await methodsFromClientRequest(noInstr)), { nativeInstructions: false, continuity: false, resumeExcludeTurns: true, setName: false, localImageInput: false, reason: "no_thread_start_instructions" });
  const noResumeField = structuredClone(union()) as Any;
  delete noResumeField.definitions.v2.ThreadResumeParams.properties.sandbox;
  assert.equal(capabilitiesFromMethods(await methodsFromClientRequest(noResumeField)).reason, "resume_params_missing");
  await assert.rejects(methodsFromClientRequest({ definitions: {} }));
});

test("capability discovery: generated-union shape of the stable schema uses thread/name/set; thread/setName is not support", async () => {
  // Mirrors the installed stable ClientRequest.json: top-level oneOf variants with
  // method.enum and params.$ref into top-level definitions.
  const str = { type: "string" };
  const variant = (method: string, def: string): object => ({
    type: "object",
    title: `${def}Request`,
    required: ["id", "method", "params"],
    properties: { id: { $ref: "#/definitions/RequestId" }, method: { type: "string", enum: [method], title: `${def}RequestMethod` }, params: { $ref: `#/definitions/${def}` } },
  });
  const policy = Object.fromEntries(["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"].map((k) => [k, { anyOf: [{ $ref: "#/definitions/Opaque" }, { type: "null" }] }]));
  const doc = (nameMethod: string): object => ({
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "ClientRequest",
    oneOf: [
      variant("thread/start", "ThreadStartParams"),
      variant("thread/resume", "ThreadResumeParams"),
      variant("turn/start", "TurnStartParams"),
      variant(nameMethod, "ThreadSetNameParams"),
    ],
    definitions: {
      RequestId: { anyOf: [str, { type: "integer" }] },
      Opaque: { type: "object" },
      ThreadStartParams: { type: "object", properties: { cwd: { type: ["string", "null"] }, model: { type: ["string", "null"] }, developerInstructions: { type: ["string", "null"] }, ...policy } },
      ThreadResumeParams: {
        type: "object",
        required: ["threadId"],
        properties: { threadId: str, cwd: { type: ["string", "null"] }, model: { type: ["string", "null"] }, developerInstructions: { type: ["string", "null"] }, excludeTurns: { type: "boolean" }, ...policy },
      },
      TurnStartParams: { type: "object", required: ["threadId", "input"], properties: { threadId: str, input: { type: "array" }, cwd: { type: ["string", "null"] }, ...policy } },
      ThreadSetNameParams: { type: "object", required: ["name", "threadId"], properties: { name: str, threadId: str } },
    },
  });
  assert.deepEqual(capabilitiesFromMethods(await methodsFromClientRequest(doc("thread/name/set"))), FULL);
  // The old wrong spelling alone proves nothing: naming stays off, continuity unaffected.
  const old = capabilitiesFromMethods(await methodsFromClientRequest(doc("thread/setName")));
  assert.deepEqual(old, { ...FULL, setName: false });
});

test("capability discovery spawns the configured launcher's schema generator in an owned temp dir that is removed", { timeout: 20_000 }, async () => {
  const dir = tmp();
  const scratch = tmp();
  const log = path.join(dir, "argv.log");
  const linkTarget = tmp();
  writeFileSync(path.join(linkTarget, "keep"), "x");
  const schema = {
    oneOf: ["thread/start", "thread/resume", "turn/start", "thread/name/set"].map((m) => ({
      type: "object",
      properties: { method: { type: "string", enum: [m] }, params: { $ref: `#/definitions/${m === "thread/name/set" ? "Ext" : "P"}` } },
    })),
    definitions: {
      P: { type: "object", properties: Object.fromEntries(["threadId", "input", "cwd", "model", "approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"].map((k) => [k, {}]).concat([["developerInstructions", { type: "string" }]])) },
    },
  };
  const bin = writeExec(
    path.join(dir, "codex"),
    nodeScript(`
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (process.env.FAKE_SCHEMA_FAIL) process.exit(3);
if (process.env.FAKE_SCHEMA_SPAM) { process.stdout.write("x".repeat(200000)); setTimeout(() => {}, 5000); return; }
const out = a[3];
fs.writeFileSync(path.join(out, "ClientRequest.json"), ${JSON.stringify(JSON.stringify(schema))});
if (process.env.FAKE_SCHEMA_DIRS) for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(out, "d" + i));
if (process.env.FAKE_SCHEMA_LINK) fs.symlinkSync(${JSON.stringify(linkTarget)}, path.join(out, "v2"));
else fs.mkdirSync(path.join(out, "v2"));
fs.writeFileSync(path.join(out, "v2", "Ext.json"), JSON.stringify({ type: "object", properties: { threadId: { type: "string" }, name: { type: "string" } } }));
`),
  );
  const env = { PATH: "/usr/bin:/bin" };
  const c = await discoverImageCapabilities(bin, { env, tmpRoot: scratch });
  assert.deepEqual(c, { nativeInstructions: true, continuity: true, resumeExcludeTurns: false, setName: true, localImageInput: false, reason: null });
  const argv = JSON.parse(readFileSync(log, "utf8").trim()) as string[];
  assert.deepEqual(argv.slice(0, 3), ["app-server", "generate-json-schema", "--out"]);
  assert.ok(argv[3]!.startsWith(scratch + path.sep));
  assert.equal(argv.length, 4, "no --experimental");
  assert.deepEqual(readdirSync(scratch), [], "temp schema dir removed");
  assert.equal((await discoverImageCapabilities(bin, { env: { ...env, FAKE_SCHEMA_FAIL: "1" }, tmpRoot: scratch })).reason, "discovery_failed");
  assert.equal((await discoverImageCapabilities(bin, { env: { ...env, FAKE_SCHEMA_SPAM: "1" }, tmpRoot: scratch })).reason, "discovery_failed");
  assert.equal((await discoverImageCapabilities(null)).reason, "launcher_invalid");
  assert.equal((await discoverImageCapabilities(path.join(dir, "missing"), { env, tmpRoot: scratch })).reason, "discovery_failed");
  assert.deepEqual(readdirSync(scratch), []);

  // Empty-directory explosion and symlinks fail closed; a symlink is never followed or deleted through.
  assert.equal((await discoverImageCapabilities(bin, { env: { ...env, FAKE_SCHEMA_DIRS: "1" }, tmpRoot: scratch })).reason, "schema_invalid");
  assert.equal((await discoverImageCapabilities(bin, { env: { ...env, FAKE_SCHEMA_LINK: "1" }, tmpRoot: scratch })).reason, "schema_invalid");
  assert.deepEqual(readdirSync(linkTarget).sort(), ["Ext.json", "keep"]);
  assert.deepEqual(readdirSync(scratch), []);
});

test("capability discovery timeout kills only the generator's own process group and reaps it before removing the temp dir", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const scratch = tmp();
  const pidLog = path.join(dir, "pids.log");
  const bin = writeExec(
    path.join(dir, "codex"),
    nodeScript(`
const fs = require("node:fs"), path = require("node:path");
const out = process.argv[5];
const w = "const fs=require('node:fs'),p=require('node:path');let n=0;setInterval(()=>{fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(p.join(process.argv[1],'tick'+(n++%4)),'x')},5)";
const g = require("node:child_process").spawn(process.execPath, ["-e", w, out], { stdio: "inherit" });
fs.writeFileSync(${JSON.stringify(pidLog)}, process.pid + " " + g.pid);
setInterval(() => fs.writeFileSync(path.join(out, "parent-tick"), "x"), 5);
`),
  );
  // An unrelated process outside the group must survive.
  const { spawn } = await import("node:child_process");
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const started = Date.now();
    const c = await discoverImageCapabilities(bin, { env: { PATH: "/usr/bin:/bin" }, tmpRoot: scratch, timeoutMs: 1_000 });
    assert.equal(c.reason, "discovery_failed");
    assert.ok(Date.now() - started < 10_000, "bounded");
    assert.deepEqual(readdirSync(scratch), [], "temp dir removed");
    const pids = readFileSync(pidLog, "utf8").trim().split(" ").map(Number);
    assert.equal(pids.length, 2);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(pids.filter(alive), [], "generator and its helper are gone");
    // Nothing writes into (or recreates) the removed temp dir afterwards.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readdirSync(scratch), []);
    assert.equal(alive(bystander.pid!), true, "unrelated process untouched");
  } finally {
    bystander.kill("SIGKILL");
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A launcher whose schema generator never finishes; it logs "pid argv" per invocation, and keeps a helper in its group. */
function hangingLauncher(dir: string): { bin: string; log: string } {
  const log = path.join(dir, "invocations.log");
  const bin = writeExec(
    path.join(dir, "codex"),
    nodeScript(`
const fs = require("node:fs");
const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pids: [process.pid, g.pid], argv: process.argv.slice(2) }) + "\\n");
setInterval(() => {}, 1000);
`),
  );
  return { bin, log };
}

const invocations = (log: string): { pids: number[]; argv: string[] }[] => {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("capability discovery abort kills and reaps only the generator's group and removes its temp dir; pre-aborted never spawns", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const scratch = tmp();
  const { bin, log } = hangingLauncher(dir);
  const { spawn } = await import("node:child_process");
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const pre = new AbortController();
    pre.abort();
    assert.equal((await discoverImageCapabilities(bin, { env: { PATH: "/usr/bin:/bin" }, tmpRoot: scratch, signal: pre.signal })).reason, "discovery_cancelled");
    assert.deepEqual(invocations(log), [], "pre-aborted: nothing spawned");
    assert.deepEqual(readdirSync(scratch), []);

    const ac = new AbortController();
    const pending = discoverImageCapabilities(bin, { env: { PATH: "/usr/bin:/bin" }, tmpRoot: scratch, signal: ac.signal });
    await until(() => invocations(log).length === 1);
    ac.abort();
    const c = await pending;
    assert.equal(c.reason, "discovery_cancelled");
    assert.equal(c.continuity, false);
    assert.deepEqual(readdirSync(scratch), [], "temp dir removed");
    const { pids } = invocations(log)[0]!;
    await until(() => !pids.some(alive), 2_000);
    assert.equal(alive(bystander.pid!), true, "unrelated process untouched");
  } finally {
    bystander.kill("SIGKILL");
  }
});

test("handler shutdown during first-call schema discovery: the pending image call is SHUTTING_DOWN and nothing native starts", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const { bin, log } = hangingLauncher(dir);
  const { w } = world();
  // Default discovery and default transport, both via the hanging launcher: any app-server spawn would be logged.
  const handler = buildServer({
    versionProbe: okProbe,
    capabilityProbe: caps,
    wallMs: 5_000,
    env: { CODEX_HOME: w.home, CODEX_IMAGE_OUTPUT_ROOT: w.out, CODEX_BIN: bin, PATH: "/usr/bin:/bin" },
  }).handler;
  const pending = handler.call("codex_image_generate", { prompt: "a red square", cwd: w.base });
  await until(() => invocations(log).length === 1);
  const [schema] = invocations(log);
  assert.deepEqual(schema!.argv.slice(0, 3), ["app-server", "generate-json-schema", "--out"]);
  let terminations = 0;
  const first = handler.shutdown(async () => void terminations++, 1_000);
  const second = handler.shutdown(async () => void terminations++, 1_000);
  assert.equal(handler.closing, true, "closing is set synchronously");
  const r = (await pending).structuredContent as Any;
  assert.equal(r.error.code, "SHUTTING_DOWN");
  await Promise.all([first, second]);
  await handler.shutdown();
  assert.equal(terminations, 1, "idempotent");
  // Shutdown resolved only after the generator group was reaped and its temp dir removed.
  assert.deepEqual(schema!.pids.filter(alive), []);
  assert.equal(existsSync(path.dirname(schema!.argv[3]!)), false, "schema temp dir removed");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(invocations(log).length, 1, "no app-server was spawned");
  assert.equal(handler.jobs.active, undefined);
  assert.equal(handler.sessions.size, 0);

  // Both starts are refused after shutdown, before any job or discovery.
  for (const [tool, args] of [
    ["codex_image_generate", { prompt: "x", cwd: w.base }],
    ["codex_task_start", { prompt: "x", cwd: w.base }],
  ] as const) {
    const res = await handler.call(tool, args);
    assert.equal((res.structuredContent as Any).error.code, "SHUTTING_DOWN", tool);
  }
  assert.equal(invocations(log).length, 1);
  assert.equal(handler.jobs.active, undefined);
});

test("handler shutdown releases a call awaiting an injected discovery and waits for that discovery to settle", async () => {
  let reaped = false;
  let started = false;
  const { w, deps } = world({
    imageCapabilities: (_launcher, signal) =>
      new Promise((resolve) => {
        started = true;
        signal.addEventListener("abort", () => setTimeout(() => ((reaped = true), resolve(FULL)), 50), { once: true });
      }),
  });
  const { handler } = buildServer(deps);
  const pending = handler.call("codex_image_generate", { prompt: "a red square", cwd: w.base });
  await until(() => started);
  const done = handler.shutdown(async () => undefined, 1_000);
  // FULL arriving after the abort must not be used to start a generation.
  assert.equal(((await pending).structuredContent as Any).error.code, "SHUTTING_DOWN");
  await done;
  assert.equal(reaped, true, "shutdown waited for the discovery");
  assert.equal(w.servers.length, 0, "no transport");
  assert.equal(handler.sessions.size, 0, "no session allocated");
  assert.equal(handler.jobs.active, undefined);
  const s = ((await handler.call("codex_status", {})).structuredContent as Any).image_sessions;
  assert.equal(s.continuity, "unknown", "a cancelled discovery is not reported or cached");
});

test("MCP tools/list: the image tool advertises session_handle and fresh_session with session guidance", async () => {
  const { deps } = world();
  const { server } = buildServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const tool = (await client.listTools()).tools.find((t) => t.name === "codex_image_generate")!;
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ["approval_mode", "aspect", "cwd", "fresh_session", "prompt", "queue", "reference_images", "session_handle", "timeout_s"]);
  assert.deepEqual(tool.inputSchema.required, ["prompt", "cwd"]);
  assert.match(tool.description!, /ONLY|only the requested change/);
  assert.match(tool.description!, /unrelated image, omit session_handle/);
  await client.close();
});
