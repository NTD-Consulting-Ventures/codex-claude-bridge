// NON-LIVE: version/capability probes and the app-server are fixtures; no Codex process is spawned here.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, promises as fsp, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MAX_COMPLETED_JOBS } from "../src/jobs.js";
import { createServer, installShutdownHandlers, makeShutdown, ToolHandler, TOOLS, wallFromEnv, type ServerDeps } from "../src/server.js";
import { getStatus, probeCapabilities, sanitizeVersion, summarizeMcpServers, summarizePlugins } from "../src/status.js";
import { agentMessage, completingScript, defaultReply, FakeAppServer, THREAD_ID, TURN_ID, turnCompleted } from "./fake-app-server.js";

const okProbe = async () => ({ ok: true, stdout: "codex-cli 0.156.0\n" });
const caps = async () => ({
  plugins: { available: true, reason: null, items: [{ name: "demo", enabled: true, installed: true }], truncated: false, has_more: false },
  mcp_servers: { available: false, reason: "x", items: [], truncated: false, has_more: null },
});
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-")));

function handler(deps: ServerDeps = {}): ToolHandler {
  return new ToolHandler({ versionProbe: okProbe, capabilityProbe: caps, env: {}, wallMs: 2_000, ...deps });
}

async function waitDone(h: ToolHandler, id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const r = (await h.call("codex_task_status", { job_id: id })).structuredContent as Record<string, unknown>;
    if (r.state !== "running") return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("job did not finish");
}

test("sanitizeVersion accepts only the expected shape", () => {
  assert.equal(sanitizeVersion("codex-cli 0.156.0\n"), "0.156.0");
  assert.equal(sanitizeVersion("codex-cli 0.156.0 user=niki@example.com"), null);
  assert.equal(sanitizeVersion(""), null);
});

test("tool schemas are strict; no model/config/url/command parameters", () => {
  for (const t of Object.values(TOOLS)) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    const props = Object.keys(t.inputSchema.properties);
    for (const p of props) assert.ok(["prompt", "cwd", "job_id"].includes(p), `${t.name}.${p}`);
  }
});

test("image tool is listed only when an output root is configured; no edit tool", () => {
  assert.ok(!handler().listTools().some((t) => t.name === "codex_image_generate"));
  const names = handler({ env: { CODEX_IMAGE_OUTPUT_ROOT: "/abs/out" } }).listTools().map((t) => t.name);
  assert.ok(names.includes("codex_image_generate"));
  assert.ok(!names.some((n) => n.includes("edit")));
});

test("wall limit defaults to 300s and is capped at 600s", () => {
  assert.equal(wallFromEnv({}), 300_000);
  assert.equal(wallFromEnv({ CODEX_TASK_WALL_SECONDS: "9999" }), 600_000);
  assert.equal(wallFromEnv({ CODEX_TASK_WALL_SECONDS: "abc" }), 300_000);
});

test("codex_status reports version, policy and plugin names", async () => {
  const r = await handler().call("codex_status", {});
  const s = r.structuredContent as Record<string, any>;
  assert.equal(s.codex_cli_version, "0.156.0");
  assert.deepEqual(s.launch, { approval_policy: "on-request", sandbox: "read-only", experimental_api: false });
  assert.deepEqual(s.plugins.items, [{ name: "demo", enabled: true, installed: true }]);
  assert.equal(s.mcp_servers.available, false);
  assert.match(s.note, /not a security boundary/);
  assert.equal((await handler().call("codex_status", { x: 1 })).isError, true);
});

test("status reports unknown listings when codex is unavailable", async () => {
  const s = await getStatus(async () => ({ ok: false, stdout: "" }), caps);
  assert.equal(s.plugins.available, false);
  assert.equal(s.plugins.reason, "codex CLI unavailable");
});

test("plugin / MCP summaries keep only safe names and booleans", () => {
  const p = summarizePlugins({
    marketplaces: [{ name: "m", path: "/Users/x", plugins: [
      { name: "good-plugin", enabled: true, installed: true, id: "secret-id", source: { url: "https://x" } },
      { name: "https://evil.example/x", enabled: true, installed: true },
      { name: "bad name with spaces", enabled: false, installed: false },
    ] }],
  });
  assert.deepEqual(p, [{ name: "good-plugin", enabled: true, installed: true }]);
  const m = summarizeMcpServers({ data: [{ name: "srv", authStatus: "oAuth", serverInfo: { url: "https://x" } }, { name: "x", authStatus: "a b c" }] });
  assert.deepEqual(m, [{ name: "srv", auth_status: "oAuth" }, { name: "x", auth_status: null }]);
  assert.throws(() => summarizePlugins({}));
});

test("capability probe uses only read-only listing methods and degrades to unknown", async () => {
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "plugin/installed") return { result: { marketplaces: [{ name: "m", plugins: [{ name: "p1", enabled: true, installed: true }] }] } };
      return defaultReply(msg);
    },
  });
  const r = await probeCapabilities(() => fake);
  assert.deepEqual(r.plugins.items, [{ name: "p1", enabled: true, installed: true }]);
  assert.equal(r.mcp_servers.available, false);
  assert.equal(r.mcp_servers.reason, "mcpServerStatus/list failed: rpc method_not_found/unrecognized");
  assert.deepEqual(fake.methods(), ["initialize", "initialized", "plugin/installed", "mcpServerStatus/list"]);
  assert.equal(fake.killed, true);
});

test("listing failure reasons are fixed enums only, never peer text", async () => {
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "plugin/installed") return { result: { nope: "SECRET" } };
      if (msg.method === "mcpServerStatus/list") {
        return { error: { code: -32600, message: "mcpServerStatus/list requires experimentalApi capability SECRET /Users/x" } };
      }
      return defaultReply(msg);
    },
  });
  const r = await probeCapabilities(() => fake);
  assert.equal(r.plugins.reason, "plugin/installed failed: invalid_response_shape");
  assert.equal(r.mcp_servers.reason, "mcpServerStatus/list failed: rpc invalid_request/experimental_api_required");
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.deepEqual(fake.received.find((m) => m.method === "mcpServerStatus/list")!.params, { detail: "toolsAndAuthOnly", limit: 50 });
  assert.deepEqual(fake.received[0]!.params!.capabilities, { experimentalApi: false, requestAttestation: false });
  assert.equal(r.mcp_servers.has_more, null);
});

test("MCP status listing pages with minimal detail, stops at its bound and reports truncated/has_more honestly", async () => {
  const page = (n: number, next: string | null) => ({
    data: Array.from({ length: 50 }, (_, i) => ({ name: `s${n}-${i}`, authStatus: "unsupported", tools: { t: { name: "t", inputSchema: {} } } })),
    nextCursor: next,
  });
  const endless = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "plugin/installed") return { result: { marketplaces: [] } };
      if (msg.method === "mcpServerStatus/list") return { result: page(Number(msg.params?.cursor ?? 0), String(Number(msg.params?.cursor ?? 0) + 1)) };
      return defaultReply(msg);
    },
  });
  const r = await probeCapabilities(() => endless);
  assert.equal(r.mcp_servers.available, true);
  assert.equal(r.mcp_servers.items.length, 100);
  assert.equal(r.mcp_servers.truncated, true);
  assert.equal(r.mcp_servers.has_more, true);
  const calls = endless.received.filter((m) => m.method === "mcpServerStatus/list");
  assert.ok(calls.length <= 4);
  assert.deepEqual(calls[1]!.params, { detail: "toolsAndAuthOnly", limit: 50, cursor: "1" });
  assert.ok(!JSON.stringify(r).includes("inputSchema"));

  const finite = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "plugin/installed") return { result: { marketplaces: [] } };
      if (msg.method === "mcpServerStatus/list") return { result: msg.params?.cursor ? { data: [{ name: "b" }], nextCursor: null } : { data: [{ name: "a" }], nextCursor: "c" } };
      return defaultReply(msg);
    },
  });
  const f = await probeCapabilities(() => finite);
  assert.deepEqual(f.mcp_servers, { available: true, reason: null, items: [{ name: "a", auth_status: null }, { name: "b", auth_status: null }], truncated: false, has_more: false });
  assert.deepEqual(f.plugins, { available: true, reason: null, items: [], truncated: false, has_more: false });
});

test("task job lifecycle: start -> status -> succeeded with text", async () => {
  const cwd = tmp();
  const h = handler({ createTransport: () => new FakeAppServer(completingScript([agentMessage("done"), turnCompleted()])) });
  const r = await h.call("codex_task_start", { prompt: "hi", cwd });
  const { job_id } = r.structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.result, { text: "done", text_truncated: false, image_items: 0 });
});

test("approval request yields failed job with APPROVAL_REQUIRED and only the request kind", async () => {
  const cwd = tmp();
  const h = handler({
    createTransport: () =>
      new FakeAppServer(completingScript([{ id: 9, method: "item/fileChange/requestApproval", params: { threadId: THREAD_ID, turnId: TURN_ID, reason: "SECRET" } }])),
  });
  const { job_id } = (await h.call("codex_task_start", { prompt: "edit", cwd })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "failed");
  assert.deepEqual(done.error, { code: "APPROVAL_REQUIRED", request_kind: "file_change", diagnostic: { phase: "turn" } });
  assert.ok(!JSON.stringify(done).includes("SECRET"));
});

test("validated cwd reaches the transport factory; thread/start rpc error surfaces only safe enums", async () => {
  const cwd = tmp();
  const seen: string[] = [];
  const h = handler({
    createTransport: (c) => {
      seen.push(c);
      return new FakeAppServer({
        onRequest(msg) {
          if (msg.method === "thread/start") return { error: { code: -32602, message: "Invalid request: missing field `cwd` at /Users/x" } };
          return defaultReply(msg);
        },
      });
    },
  });
  const { job_id } = (await h.call("codex_task_start", { prompt: "x", cwd })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.deepEqual(seen, [cwd]);
  assert.equal(done.state, "failed");
  assert.deepEqual(done.error, {
    code: "THREAD_START_FAILED",
    diagnostic: { phase: "thread_start", rpc_code: -32602, rpc_class: "invalid_params", message_class: "missing_field", field: "cwd" },
  });
  assert.ok(!JSON.stringify(done).includes("/Users/x"));
});

test("single active job; cancel; argument and cwd validation", async () => {
  const cwd = tmp();
  const h = handler({ wallMs: 60_000, createTransport: () => new FakeAppServer() });
  const { job_id } = (await h.call("codex_task_start", { prompt: "long", cwd })).structuredContent as { job_id: string };
  const busy = await h.call("codex_task_start", { prompt: "x", cwd });
  assert.equal((busy.structuredContent as any).error.code, "BUSY");
  const c = await h.call("codex_task_cancel", { job_id });
  assert.equal((c.structuredContent as any).cancel_requested, true);
  assert.equal((await waitDone(h, job_id)).state, "cancelled");

  assert.equal((await h.call("codex_task_start", { prompt: "x", cwd, model: "o" })).isError, true);
  assert.equal((await h.call("codex_task_start", { prompt: "", cwd })).isError, true);
  for (const bad of ["relative", "/does/not/exist", "/", os.homedir(), cwd + "/../" + path.basename(cwd)]) {
    const r = await h.call("codex_task_start", { prompt: "x", cwd: bad });
    assert.equal((r.structuredContent as any).error.code, "INVALID_CWD", bad);
  }
  assert.equal((await h.call("codex_task_status", { job_id: "00000000-0000-4000-8000-000000000000" })).isError, true);
  const noRoot = await h.call("codex_image_generate", { prompt: "x", cwd });
  assert.equal((noRoot.structuredContent as any).error.code, "OUTPUT_ROOT_NOT_CONFIGURED");
});

test("completed jobs are bounded", async () => {
  const cwd = tmp();
  const h = handler({ createTransport: () => new FakeAppServer(completingScript([turnCompleted()])) });
  const ids: string[] = [];
  for (let i = 0; i < MAX_COMPLETED_JOBS + 3; i++) {
    const { job_id } = (await h.call("codex_task_start", { prompt: "x", cwd })).structuredContent as { job_id: string };
    ids.push(job_id);
    await waitDone(h, job_id);
  }
  assert.equal((await h.call("codex_task_status", { job_id: ids[0]! })).isError, true);
  assert.equal((await h.call("codex_task_status", { job_id: ids.at(-1)! })).isError, undefined);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function imageScript(savedPath: string | null): FakeAppServer {
  return new FakeAppServer(
    completingScript([
      agentMessage("here is your image"),
      { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "imageGeneration", id: "g", result: "", status: "completed", savedPath } } },
      turnCompleted(),
    ]),
  );
}

test("image job verifies native savedPath and copies into owned UUID subdir", async () => {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const src = path.join(home, "generated_images", "img.png");
  writeFileSync(src, PNG);
  const out = path.join(base, "out");
  const h = handler({ env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: out }, createTransport: () => imageScript(src) });
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "succeeded");
  const r = done.result as any;
  assert.deepEqual(Object.keys(r).sort(), ["codex_version", "files", "job_id"]);
  assert.equal(r.job_id, job_id);
  assert.equal(r.codex_version, "0.156.0");
  assert.equal(r.files.length, 1);
  const img = r.files[0];
  assert.deepEqual(Object.keys(img).sort(), ["bytes", "mime_type", "path", "sha256"]);
  assert.equal(img.mime_type, "image/png");
  assert.equal(img.bytes, PNG.length);
  assert.equal(img.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.match(path.relative(out, img.path), /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
  assert.equal(readdirSync(out).length, 1);
});

test("text-only completion is not image success; non-image or outside-home paths fail", async () => {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(home);
  const notImg = path.join(home, "x.png");
  writeFileSync(notImg, "not an image");
  const outside = path.join(base, "outside.png");
  writeFileSync(outside, PNG);
  for (const [saved, code] of [[null, "NO_IMAGE_PRODUCED"], [notImg, "IMAGE_VERIFICATION_FAILED"], [outside, "IMAGE_VERIFICATION_FAILED"]] as const) {
    const h = handler({ env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: path.join(base, "out") }, createTransport: () => imageScript(saved) });
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "failed");
    assert.equal((done.error as any).code, code);
  }
});

test("delegating tools are conservatively annotated destructive", () => {
  assert.equal(TOOLS.codex_task_start.annotations.destructiveHint, true);
  assert.equal(TOOLS.codex_image_generate.annotations.destructiveHint, true);
  assert.equal(TOOLS.codex_task_start.annotations.readOnlyHint, false);
  assert.equal(TOOLS.codex_image_generate.annotations.readOnlyHint, false);
  assert.equal(TOOLS.codex_status.annotations.readOnlyHint, true);
  assert.equal(TOOLS.codex_task_status.annotations.readOnlyHint, true);
});

// Deterministic gates. `afterStep` gates hold the job AFTER the output mkdir /
// copy has already completed; the version-probe gate holds the probe itself in
// flight. True in-flight filesystem gates (mocked fsp.mkdir and
// FileHandle.writeFile) follow further below.
interface Gate {
  entered: Promise<void>;
  release: () => void;
  hold: () => Promise<void>;
}
function gate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const released = new Promise<void>((r) => (release = r));
  return { entered, release, hold: async () => (enter(), await released) };
}

function imageFixture(deps: (g: Gate) => ServerDeps, wallMs = 60_000): { h: ToolHandler; g: Gate; out: string; base: string } {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const src = path.join(home, "generated_images", "img.png");
  writeFileSync(src, PNG);
  const out = path.join(base, "out");
  const g = gate();
  const h = handler({ wallMs, env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: out }, createTransport: () => imageScript(src), ...deps(g) });
  return { h, g, out, base };
}
const afterStep = (step: "mkdir" | "copy") => (g: Gate): ServerDeps => ({ imageAfterStep: async (s) => (s === step ? g.hold() : undefined) });
const atVersion = (g: Gate): ServerDeps => ({ versionProbe: async () => (await g.hold(), { ok: true, stdout: "codex-cli 0.156.0\n" }) });
const ownedEntries = (out: string): string[] => {
  try {
    return readdirSync(out);
  } catch {
    return [];
  }
};

for (const [label, deps] of [["after-mkdir gate", afterStep("mkdir")], ["after-copy gate", afterStep("copy")], ["in-flight version probe", atVersion]] as const) {
  test(`cancel during ${label}: stays BUSY until in-flight work settles, then CANCELLED with owned output removed`, async () => {
    const { h, g, out, base } = imageFixture(deps);
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    await g.entered;
    assert.equal(ownedEntries(out).length, 1, "owned dir exists while gated");
    const c = (await h.call("codex_task_cancel", { job_id })).structuredContent as any;
    assert.equal(c.cancel_requested, true);
    assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, false, "second cancel is a no-op");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.jobs.active, job_id, "BUSY is not released while work is outstanding");
    assert.equal(((await h.call("codex_task_start", { prompt: "x", cwd: base })).structuredContent as any).error.code, "BUSY");
    g.release();
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "cancelled");
    assert.equal((done.error as any).code, "CANCELLED");
    assert.equal(done.result, null);
    assert.deepEqual(ownedEntries(out), [], "only the owned UUID dir existed and it was removed");
    assert.equal(h.jobs.active, undefined);
  });

  test(`deadline during ${label}: TIMEOUT root cause wins over a later cancel; owned output removed`, async () => {
    const { h, g, out, base } = imageFixture(deps, 150);
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    await g.entered;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.jobs.active, job_id, "still BUSY past the deadline while gated work is outstanding");
    assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, false);
    g.release();
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "failed");
    assert.equal((done.error as any).code, "TIMEOUT");
    assert.deepEqual(ownedEntries(out), []);
    assert.equal(h.jobs.active, undefined);
  });
}

test("cancel before the deadline stays CANCELLED even when the deadline passes during gated work", async () => {
  const { h, g, out, base } = imageFixture(atVersion, 150);
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  await g.entered;
  await h.call("codex_task_cancel", { job_id });
  await new Promise((r) => setTimeout(r, 200));
  g.release();
  const done = await waitDone(h, job_id);
  assert.equal((done.error as any).code, "CANCELLED");
  assert.deepEqual(ownedEntries(out), []);
});

test("cancel after completion is refused and leaves the succeeded result and files intact", async () => {
  const { h, g, out, base } = imageFixture(atVersion);
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  await g.entered;
  g.release();
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "succeeded");
  const c = (await h.call("codex_task_cancel", { job_id })).structuredContent as any;
  assert.equal(c.cancel_requested, false);
  assert.equal(c.state, "succeeded");
  assert.equal((await waitDone(h, job_id)).state, "succeeded");
  assert.equal(ownedEntries(out).length, 1);
});

test("version probe failure after collection still succeeds with null version (no output removed)", async () => {
  const { h, out, base } = imageFixture(() => ({ versionProbe: async () => ({ ok: false, stdout: "" }) }));
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "succeeded");
  assert.equal((done.result as any).codex_version, null);
  assert.equal(ownedEntries(out).length, 1);
});

test("shutdown at the after-copy gate: grace expires without releasing BUSY; release then cancels and cleans up", async () => {
  const { h, g, out, base } = imageFixture(afterStep("copy"));
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  await g.entered;
  let terminations = 0;
  const shutdown = makeShutdown(h.jobs, async () => void terminations++, 30);
  await shutdown();
  assert.equal(terminations, 1);
  assert.equal(h.jobs.active, job_id, "copy still in flight: job not released");
  g.release();
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "cancelled");
  assert.deepEqual(ownedEntries(out), []);
  assert.equal(h.jobs.active, undefined);
});

// True in-flight filesystem gates: the production ToolHandler runs unchanged
// while a test mock holds the real fsp.mkdir(outputRoot) / destination
// FileHandle.writeFile before the underlying call is made. Mocks are restored
// by t.mock after each test; tests in this file run sequentially.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function within<T>(p: Promise<T>, what: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} not reached within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}

function inFlightFixture(wallMs: number): { h: ToolHandler; g: Gate; out: string; base: string; src: string } {
  const f = imageFixture(() => ({}), wallMs);
  mkdirSync(f.out);
  writeFileSync(path.join(f.out, "sentinel.txt"), "keep");
  return { ...f, src: path.join(f.base, "codex-home", "generated_images", "img.png") };
}

function assertIntact(out: string, src: string): void {
  assert.deepEqual(ownedEntries(out), ["sentinel.txt"], "only the owned UUID dir was removed");
  assert.equal(readFileSync(path.join(out, "sentinel.txt"), "utf8"), "keep", "unrelated output-root content intact");
  assert.deepEqual(readFileSync(src), PNG, "source image intact");
}

for (const mode of ["deadline", "cancel"] as const) {
  const code = mode === "deadline" ? "TIMEOUT" : "CANCELLED";

  test(`in-flight fsp.mkdir(outputRoot) held (${mode}): BUSY until mkdir returns, then ${code}, never succeeded`, { timeout: 10_000 }, async (t) => {
    const { h, g, out, base, src } = inFlightFixture(mode === "deadline" ? 50 : 60_000);
    const realMkdir = fsp.mkdir;
    t.mock.method(fsp, "mkdir", async (p: unknown, ...rest: unknown[]) => {
      if (p === out) await g.hold();
      return (realMkdir as (...a: unknown[]) => Promise<unknown>).call(fsp, p, ...rest);
    });
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    try {
      await within(g.entered, "mkdir(outputRoot)");
      if (mode === "cancel") assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, true);
      await sleep(100);
      assert.equal(h.jobs.active, job_id, "BUSY while mkdir is in flight");
      assert.equal(h.jobs.get(job_id)?.state, "running");
      assert.equal(((await h.call("codex_task_start", { prompt: "x", cwd: base })).structuredContent as any).error.code, "BUSY");
      assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, false, "late cancel refused");
      assert.deepEqual(ownedEntries(out), ["sentinel.txt"], "no owned dir created yet");
    } finally {
      g.release();
    }
    const done = await waitDone(h, job_id);
    assert.equal(done.state, mode === "deadline" ? "failed" : "cancelled");
    assert.equal((done.error as any).code, code);
    assert.equal(done.result, null);
    assertIntact(out, src);
    assert.equal(h.jobs.active, undefined);
  });

  test(`in-flight destination writeFile held (${mode}): BUSY, write not abandoned, then ${code} with owned output removed`, { timeout: 10_000 }, async (t) => {
    const { h, g, out, base, src } = inFlightFixture(mode === "deadline" ? 50 : 60_000);
    const events: string[] = [];
    let dest: string | undefined;
    const realOpen = fsp.open;
    const realRm = fsp.rm;
    t.mock.method(fsp, "open", async (p: unknown, ...rest: unknown[]) => {
      const fh = await (realOpen as (...a: unknown[]) => Promise<any>).call(fsp, p, ...rest);
      if (typeof p === "string" && p.startsWith(out + path.sep)) {
        dest = p;
        const realWrite = fh.writeFile.bind(fh);
        fh.writeFile = async (...a: unknown[]) => {
          events.push("write-start");
          await g.hold();
          await realWrite(...a);
          events.push("write-done");
        };
      }
      return fh;
    });
    t.mock.method(fsp, "rm", async (...a: unknown[]) => {
      events.push("rm");
      return (realRm as (...x: unknown[]) => Promise<void>).call(fsp, ...a);
    });
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    try {
      await within(g.entered, "destination writeFile");
      if (mode === "cancel") assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, true);
      await sleep(100);
      assert.equal(h.jobs.active, job_id, "BUSY while the destination write is in flight");
      assert.equal(((await h.call("codex_task_start", { prompt: "x", cwd: base })).structuredContent as any).error.code, "BUSY");
      assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, false, "late cancel refused");
      assert.deepEqual(events, ["write-start"], "no cleanup while the write is outstanding");
      assert.ok(dest !== undefined && existsSync(dest), "destination exists while write is held");
    } finally {
      g.release();
    }
    const done = await waitDone(h, job_id);
    assert.equal(done.state, mode === "deadline" ? "failed" : "cancelled");
    assert.equal((done.error as any).code, code);
    assert.equal(done.result, null);
    assert.deepEqual(events.slice(0, 2), ["write-start", "write-done"], "write completed before any removal");
    assert.ok(events.length > 2 && events.slice(2).every((e) => e === "rm"));
    assert.equal(existsSync(dest as string), false);
    assertIntact(out, src);
    assert.equal(h.jobs.active, undefined);
  });
}

test("shutdown cancels the active job, interrupts its turn, kills it, then terminates all app-servers once", async () => {
  const cwd = tmp();
  const fake = new FakeAppServer();
  const h = handler({ wallMs: 60_000, createTransport: () => fake });
  const { job_id } = (await h.call("codex_task_start", { prompt: "long", cwd })).structuredContent as { job_id: string };
  await new Promise((r) => setTimeout(r, 10));
  let terminations = 0;
  const shutdown = makeShutdown(h.jobs, async () => void terminations++, 1_000);
  await Promise.all([shutdown(), shutdown()]);
  assert.equal(terminations, 1);
  assert.equal(h.jobs.active, undefined);
  assert.equal((await waitDone(h, job_id)).state, "cancelled");
  assert.ok(fake.methods().includes("turn/interrupt"));
  assert.equal(fake.killed, true);
});

test("shutdown still terminates app-servers when no job is active", async () => {
  let terminations = 0;
  await makeShutdown(handler().jobs, async () => void terminations++)();
  assert.equal(terminations, 1);
});

for (const [trigger, code] of [["onclose", 0], ["end", 0], ["close", 0], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`shutdown handler runs once on ${trigger} and exits ${code}`, async () => {
    const proc = new EventEmitter();
    const stdin = new EventEmitter();
    const server: { onclose?: () => void } = {};
    let runs = 0;
    const exits: number[] = [];
    let exited!: () => void;
    const exitedP = new Promise<void>((r) => (exited = r));
    installShutdownHandlers(async () => void runs++, {
      server,
      proc: proc as unknown as NodeJS.Process,
      stdin: stdin as unknown as NodeJS.ReadableStream,
      exit: (c) => {
        exits.push(c);
        exited();
      },
    });
    if (trigger === "onclose") server.onclose?.();
    else if (trigger === "end" || trigger === "close") stdin.emit(trigger);
    else proc.emit(trigger);
    proc.emit("SIGTERM");
    stdin.emit("end");
    await exitedP;
    assert.equal(runs, 1);
    assert.deepEqual(exits, [code]);
  });
}

test("MCP server lists tools over MCP", async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer({ versionProbe: okProbe, capabilityProbe: caps, env: {} });
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["codex_status", "codex_task_start", "codex_task_status", "codex_task_cancel"]);
  const res = await client.callTool({ name: "codex_status", arguments: {} });
  assert.equal((res.structuredContent as any).codex_cli_version, "0.156.0");
  await client.close();
  await server.close();
});
