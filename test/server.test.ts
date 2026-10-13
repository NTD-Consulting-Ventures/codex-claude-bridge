// NON-LIVE: version/capability probes and the app-server are fixtures; no Codex process is spawned here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, promises as fsp, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BRIDGE_MODE_INVALID_MESSAGE, BridgeModeError, resolveBridgeMode } from "../src/bridge-mode.js";
import { MAX_COMPLETED_JOBS } from "../src/jobs.js";
import {
  buildServer,
  createServer,
  EXIT_INVALID_BRIDGE_MODE,
  installShutdownHandlers,
  makeShutdown,
  MAX_PROMPT_CHARS,
  MODE_TOOLS,
  ToolHandler,
  TOOLS,
  wallFromEnv,
  type ServerDeps,
  type ToolResult,
} from "../src/server.js";
import { getStatus, probeCapabilities, sanitizeVersion, summarizeMcpServers, summarizePlugins } from "../src/status.js";
import { agentMessage, completingScript, defaultReply, FakeAppServer, THREAD_ID, threadStartResult, TURN_ID, turnCompleted } from "./fake-app-server.js";

const okProbe = async () => ({ ok: true, stdout: "codex-cli 0.156.0\n" });
const caps = async () => ({
  plugins: { available: true, reason: null, items: [{ name: "demo", enabled: true, installed: true }], truncated: false, has_more: false },
  mcp_servers: { available: false, reason: "x", items: [], truncated: false, has_more: null },
});
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-")));

function handler(deps: ServerDeps = {}): ToolHandler {
  return new ToolHandler({ versionProbe: okProbe, capabilityProbe: caps, env: {}, wallMs: 2_000, ...deps });
}

const IMAGE_ONLY = { CODEX_BRIDGE_MODE: "image-only" };
/** Image-path tests run unchanged under the default (general) mode and under image-only. */
const MODE_ENVS: readonly (readonly [string, Record<string, string>])[] = [["general", {}], ["image-only", IMAGE_ONLY]];
/** A second start that must be BUSY; codex_task_start is not exposed in image-only. */
const startAnother = (h: ToolHandler, cwd: string) => h.call(h.mode === "image-only" ? "codex_image_generate" : "codex_task_start", { prompt: "x", cwd });

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
  assert.equal(sanitizeVersion("codex-cli 0.156.0 user=example-user@example.com"), null);
  assert.equal(sanitizeVersion(""), null);
});

test("tool schemas are strict; no model/config/url/command parameters", () => {
  for (const t of Object.values(TOOLS)) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    const props = Object.keys(t.inputSchema.properties);
    for (const p of props) assert.ok(["prompt", "cwd", "job_id"].includes(p), `${t.name}.${p}`);
  }
});

test("image tool is listed with no env (default root), with an override and with an invalid root; no edit tool", () => {
  for (const env of [{}, { CODEX_IMAGE_OUTPUT_ROOT: "/abs/out" }, { CODEX_IMAGE_OUTPUT_ROOT: "" }]) {
    const names = handler({ env }).listTools().map((t) => t.name);
    assert.ok(names.includes("codex_image_generate"), JSON.stringify(env));
    assert.ok(!names.some((n) => n.includes("edit")));
  }
});

test("codex_status with no env reports the default root ~/codex-images as enabled", async () => {
  const s = (await handler().call("codex_status", {})).structuredContent as Record<string, any>;
  assert.equal(s.image_generate_enabled, true);
  assert.deepEqual(s.image_output, { root: path.join(os.homedir(), "codex-images"), source: "default", error: null });
  assert.equal(s.server_version, "0.2.2");
  const o = (await handler({ env: { CODEX_IMAGE_OUTPUT_ROOT: "/abs/out" } }).call("codex_status", {})).structuredContent as Record<string, any>;
  assert.deepEqual(o.image_output, { root: "/abs/out", source: "env", error: null });
});

test("invalid explicit root: status reports a sanitized error (not default/disabled success) and both tools fail before any job", async () => {
  const cwd = tmp();
  for (const [raw, reason] of [["", "empty"], ["rel/SECRET", "relative"], ["/a/../SECRET", "not_normalized"], ["/SECRET/", "not_normalized"], ["/", "filesystem_root"], ["/SECRET\0x", "nul_byte"]] as const) {
    let spawned = 0;
    const h = handler({ env: { CODEX_IMAGE_OUTPUT_ROOT: raw }, createTransport: () => (spawned++, new FakeAppServer(completingScript([turnCompleted()]))) });
    const s = (await h.call("codex_status", {})).structuredContent as Record<string, any>;
    assert.equal(s.image_generate_enabled, false, raw);
    assert.equal(s.image_output.root, null);
    assert.equal(s.image_output.source, "env");
    assert.equal(s.image_output.error.code, "OUTPUT_ROOT_INVALID");
    assert.equal(s.image_output.error.reason, reason, raw);
    assert.ok(!JSON.stringify(s).includes("SECRET"));
    for (const tool of ["codex_task_start", "codex_image_generate"]) {
      const r = await h.call(tool, { prompt: "x", cwd });
      assert.equal(r.isError, true);
      assert.equal((r.structuredContent as any).error.code, "OUTPUT_ROOT_INVALID", `${tool} ${raw}`);
      assert.ok(!JSON.stringify(r).includes("SECRET"));
    }
    assert.equal(h.jobs.active, undefined);
    assert.equal(spawned, 0, "no job began");
  }
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
  assert.deepEqual(s.launch, {
    approval_policy: "on-request",
    approvals_reviewer: "user",
    sandbox: "workspace-write",
    writable_roots: "task_cwd_only",
    network_access: false,
    temp_dirs_writable: false,
    experimental_api: false,
  });
  assert.deepEqual(s.plugins.items, [{ name: "demo", enabled: true, installed: true }]);
  assert.equal(s.mcp_servers.available, false);
  assert.match(s.note, /not a security boundary/);
  assert.match(s.note, /workspace-write/);
  assert.doesNotMatch(s.note, /read-only/);
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
  assert.deepEqual(done.result, { text: "done", text_truncated: false, image_items: 0, files: [] });
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

test("task tool description states the bounded workspace-write policy, not read-only", () => {
  const d = TOOLS.codex_task_start.description;
  assert.match(d, /workspace-write/);
  assert.match(d, /APPROVAL_REQUIRED/);
  assert.doesNotMatch(d, /read-only/);
});

test("ambient writable root in the effective thread policy fails the job with POLICY_MISMATCH and no turn", async () => {
  const cwd = tmp();
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "thread/start") return { result: threadStartResult(msg.params?.cwd, {}, { writableRoots: [msg.params?.cwd, "/Users/x/SECRET"] }) };
      return defaultReply(msg);
    },
  });
  const h = handler({ createTransport: () => fake });
  const { job_id } = (await h.call("codex_task_start", { prompt: "x", cwd })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "failed");
  assert.deepEqual(done.error, { code: "POLICY_MISMATCH", diagnostic: { phase: "thread_start", policy_mismatch: "writable_roots" } });
  assert.ok(!JSON.stringify(done).includes("SECRET"));
  assert.ok(!fake.methods().includes("turn/start"));
});

test("validated canonical cwd is sent as thread cwd, turn cwd and the only writable root", async () => {
  const cwd = tmp();
  const fake = new FakeAppServer(completingScript([turnCompleted()]));
  const h = handler({ createTransport: () => fake });
  const { job_id } = (await h.call("codex_task_start", { prompt: "x", cwd })).structuredContent as { job_id: string };
  assert.equal((await waitDone(h, job_id)).state, "succeeded");
  const ts = fake.received.find((m) => m.method === "thread/start")!.params!;
  const tr = fake.received.find((m) => m.method === "turn/start")!.params!;
  assert.equal(ts.cwd, cwd);
  assert.equal(tr.cwd, cwd);
  assert.deepEqual((tr.sandboxPolicy as { writableRoots: unknown }).writableRoots, [cwd]);
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

for (const [mode, modeEnv] of MODE_ENVS) {
test(`image job verifies native savedPath and copies into owned UUID subdir (${mode})`, async () => {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const src = path.join(home, "generated_images", "img.png");
  writeFileSync(src, PNG);
  const out = path.join(base, "out");
  const h = handler({ env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: out, ...modeEnv }, createTransport: () => imageScript(src) });
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

test(`text-only completion is not image success; non-image or outside-home paths fail (${mode})`, async () => {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(home);
  const notImg = path.join(home, "x.png");
  writeFileSync(notImg, "not an image");
  const outside = path.join(base, "outside.png");
  writeFileSync(outside, PNG);
  for (const [saved, code] of [[null, "IMAGE_ITEM_INVALID"], [notImg, "IMAGE_VERIFICATION_FAILED"], [outside, "IMAGE_VERIFICATION_FAILED"]] as const) {
    const h = handler({ env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: path.join(base, "out"), ...modeEnv }, createTransport: () => imageScript(saved) });
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "failed");
    assert.equal((done.error as any).code, code);
  }
});
}

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

function imageFixture(
  deps: (g: Gate) => ServerDeps,
  wallMs = 60_000,
  modeEnv: Record<string, string> = {},
): { h: ToolHandler; g: Gate; out: string; base: string } {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const src = path.join(home, "generated_images", "img.png");
  writeFileSync(src, PNG);
  const out = path.join(base, "out");
  const g = gate();
  const h = handler({ wallMs, env: { CODEX_HOME: home, CODEX_IMAGE_OUTPUT_ROOT: out, ...modeEnv }, createTransport: () => imageScript(src), ...deps(g) });
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

for (const [mode, modeEnv] of MODE_ENVS)
for (const [label, deps] of [["after-mkdir gate", afterStep("mkdir")], ["after-copy gate", afterStep("copy")], ["in-flight version probe", atVersion]] as const) {
  test(`cancel during ${label} (${mode}): stays BUSY until in-flight work settles, then CANCELLED with owned output removed`, async () => {
    const { h, g, out, base } = imageFixture(deps, 60_000, modeEnv);
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
    await g.entered;
    assert.equal(ownedEntries(out).length, 1, "owned dir exists while gated");
    const c = (await h.call("codex_task_cancel", { job_id })).structuredContent as any;
    assert.equal(c.cancel_requested, true);
    assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, false, "second cancel is a no-op");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.jobs.active, job_id, "BUSY is not released while work is outstanding");
    assert.equal(((await startAnother(h, base)).structuredContent as any).error.code, "BUSY");
    g.release();
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "cancelled");
    assert.equal((done.error as any).code, "CANCELLED");
    assert.equal(done.result, null);
    assert.deepEqual(ownedEntries(out), [], "only the owned UUID dir existed and it was removed");
    assert.equal(h.jobs.active, undefined);
  });

  test(`deadline during ${label} (${mode}): TIMEOUT root cause wins over a later cancel; owned output removed`, async () => {
    const { h, g, out, base } = imageFixture(deps, 150, modeEnv);
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

for (const [mode, modeEnv] of MODE_ENVS) {
test(`cancel before the deadline stays CANCELLED even when the deadline passes during gated work (${mode})`, async () => {
  const { h, g, out, base } = imageFixture(atVersion, 150, modeEnv);
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  await g.entered;
  await h.call("codex_task_cancel", { job_id });
  await new Promise((r) => setTimeout(r, 200));
  g.release();
  const done = await waitDone(h, job_id);
  assert.equal((done.error as any).code, "CANCELLED");
  assert.deepEqual(ownedEntries(out), []);
});

test(`cancel after completion is refused and leaves the succeeded result and files intact (${mode})`, async () => {
  const { h, g, out, base } = imageFixture(atVersion, 60_000, modeEnv);
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

test(`version probe failure after collection still succeeds with null version (no output removed) (${mode})`, async () => {
  const { h, out, base } = imageFixture(() => ({ versionProbe: async () => ({ ok: false, stdout: "" }) }), 60_000, modeEnv);
  const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: base })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "succeeded");
  assert.equal((done.result as any).codex_version, null);
  assert.equal(ownedEntries(out).length, 1);
});

test(`shutdown at the after-copy gate: grace expires without releasing BUSY; release then cancels and cleans up (${mode})`, async () => {
  const { h, g, out, base } = imageFixture(afterStep("copy"), 60_000, modeEnv);
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
}

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

function inFlightFixture(wallMs: number, modeEnv: Record<string, string> = {}): { h: ToolHandler; g: Gate; out: string; base: string; src: string } {
  const f = imageFixture(() => ({}), wallMs, modeEnv);
  mkdirSync(f.out);
  writeFileSync(path.join(f.out, "sentinel.txt"), "keep");
  return { ...f, src: path.join(f.base, "codex-home", "generated_images", "img.png") };
}

function assertIntact(out: string, src: string): void {
  assert.deepEqual(ownedEntries(out), ["sentinel.txt"], "only the owned UUID dir was removed");
  assert.equal(readFileSync(path.join(out, "sentinel.txt"), "utf8"), "keep", "unrelated output-root content intact");
  assert.deepEqual(readFileSync(src), PNG, "source image intact");
}

for (const [bridgeMode, modeEnv] of MODE_ENVS)
for (const mode of ["deadline", "cancel"] as const) {
  const code = mode === "deadline" ? "TIMEOUT" : "CANCELLED";

  test(`in-flight fsp.mkdir(outputRoot) held (${mode}, ${bridgeMode}): BUSY until mkdir returns, then ${code}, never succeeded`, { timeout: 10_000 }, async (t) => {
    const { h, g, out, base, src } = inFlightFixture(mode === "deadline" ? 50 : 60_000, modeEnv);
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
      assert.equal(((await startAnother(h, base)).structuredContent as any).error.code, "BUSY");
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

  test(`in-flight destination writeFile held (${mode}, ${bridgeMode}): BUSY, write not abandoned, then ${code} with owned output removed`, { timeout: 10_000 }, async (t) => {
    const { h, g, out, base, src } = inFlightFixture(mode === "deadline" ? 50 : 60_000, modeEnv);
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
      assert.equal(((await startAnother(h, base)).structuredContent as any).error.code, "BUSY");
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

test("shutdown (image-only) cancels the active image job, interrupts its turn, kills it, then terminates all app-servers once", async () => {
  const cwd = tmp();
  const fake = new FakeAppServer();
  const h = handler({ wallMs: 60_000, env: { ...IMAGE_ONLY, CODEX_IMAGE_OUTPUT_ROOT: path.join(cwd, "out") }, createTransport: () => fake });
  const { job_id } = (await h.call("codex_image_generate", { prompt: "long", cwd })).structuredContent as { job_id: string };
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
  assert.deepEqual(tools.map((t) => t.name), ["codex_status", "codex_task_start", "codex_task_status", "codex_task_cancel", "codex_image_generate"]);
  const res = await client.callTool({ name: "codex_status", arguments: {} });
  assert.equal((res.structuredContent as any).codex_cli_version, "0.156.0");
  await client.close();
  await server.close();
});

// General codex_task_start: every native imageGeneration savedPath is saved.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 2), Buffer.from([0xff, 0xd9])]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const imgItem = (id: string, savedPath: string | null, status = "completed"): object => ({
  method: "item/completed",
  params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "imageGeneration", id, result: "", status, savedPath } },
});

function taskImageFixture(): { base: string; home: string; out: string; png: string; jpg: string } {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const png = path.join(home, "generated_images", "a.png");
  const jpg = path.join(home, "generated_images", "b.jpg");
  writeFileSync(png, PNG);
  writeFileSync(jpg, JPEG);
  return { base, home, out: path.join(base, "out"), png, jpg };
}

test("codex_task_start saves ALL native images (deduplicated) into one owned UUID dir and keeps text fields", async () => {
  const f = taskImageFixture();
  const frames = [agentMessage("made two"), imgItem("g1", f.png), imgItem("g2", f.jpg), imgItem("g3", f.png), turnCompleted()];
  const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out }, createTransport: () => new FakeAppServer(completingScript(frames)) });
  const { job_id } = (await h.call("codex_task_start", { prompt: "draw", cwd: f.base })).structuredContent as { job_id: string };
  const done = await waitDone(h, job_id);
  assert.equal(done.state, "succeeded");
  const r = done.result as any;
  assert.deepEqual(Object.keys(r).sort(), ["files", "image_items", "text", "text_truncated"]);
  assert.equal(r.text, "made two");
  assert.equal(r.text_truncated, false);
  assert.equal(r.image_items, 3);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.files.map((x: any) => [x.mime_type, x.bytes, x.sha256]), [["image/png", PNG.length, sha(PNG)], ["image/jpeg", JPEG.length, sha(JPEG)]]);
  const dirs = readdirSync(f.out);
  assert.equal(dirs.length, 1);
  for (const x of r.files) {
    assert.match(path.relative(f.out, x.path), /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg)$/);
    assert.equal(path.dirname(x.path), path.join(f.out, dirs[0]!));
    assert.equal(sha(readFileSync(x.path)), x.sha256);
  }
});

test("codex_task_start fails clearly on missing/unsupported/unverifiable/excess image items and leaves no output", async () => {
  const f = taskImageFixture();
  const notImg = path.join(f.home, "generated_images", "x.png");
  writeFileSync(notImg, "not an image");
  const outside = path.join(f.base, "outside.png");
  writeFileSync(outside, PNG);
  const cases: [string, object[], string][] = [
    ["missing savedPath", [imgItem("g1", f.png), imgItem("g2", null)], "IMAGE_ITEM_INVALID"],
    ["failed status", [imgItem("g1", f.png, "failed")], "IMAGE_ITEM_INVALID"],
    ["not an image", [imgItem("g1", f.png), imgItem("g2", notImg)], "IMAGE_VERIFICATION_FAILED"],
    ["outside codex home", [imgItem("g1", outside)], "IMAGE_VERIFICATION_FAILED"],
    ["caller-style relative path", [imgItem("g1", "generated_images/a.png")], "IMAGE_VERIFICATION_FAILED"],
    ["more items than the bound", Array.from({ length: 9 }, (_, i) => imgItem(`g${i}`, f.png)), "IMAGE_ITEM_INVALID"],
  ];
  for (const [label, items, code] of cases) {
    const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out }, createTransport: () => new FakeAppServer(completingScript([agentMessage("t"), ...items, turnCompleted()])) });
    const { job_id } = (await h.call("codex_task_start", { prompt: "draw", cwd: f.base })).structuredContent as { job_id: string };
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "failed", label);
    assert.equal((done.error as any).code, code, label);
    assert.equal(done.result, null, label);
    assert.deepEqual(ownedEntries(f.out), [], label);
  }
  assert.deepEqual(readFileSync(f.png), PNG, "source intact");
});

for (const [mode, modeEnv] of MODE_ENVS) {
  test(`codex_image_generate: a text-only completion is NO_IMAGE_PRODUCED (${mode})`, async () => {
    const f = taskImageFixture();
    const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out, ...modeEnv }, createTransport: () => new FakeAppServer(completingScript([agentMessage("no"), turnCompleted()])) });
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: f.base })).structuredContent as { job_id: string };
    assert.equal(((await waitDone(h, job_id)).error as any).code, "NO_IMAGE_PRODUCED");
    assert.deepEqual(ownedEntries(f.out), []);
  });

  test(`codex_image_generate saves a native JPEG too (${mode})`, async () => {
    const f = taskImageFixture();
    const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out, ...modeEnv }, createTransport: () => new FakeAppServer(completingScript([imgItem("g", f.jpg), turnCompleted()])) });
    const { job_id } = (await h.call("codex_image_generate", { prompt: "a cat", cwd: f.base })).structuredContent as { job_id: string };
    const done = await waitDone(h, job_id);
    assert.equal(done.state, "succeeded");
    assert.deepEqual((done.result as any).files.map((x: any) => [x.mime_type, x.sha256]), [["image/jpeg", sha(JPEG)]]);
    assert.match(path.relative(f.out, (done.result as any).files[0].path), /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);
  });
}

test("symlinked output root (or ancestor) gets no writes: OUTPUT_ROOT_UNAVAILABLE", async () => {
  const f = taskImageFixture();
  const target = path.join(f.base, "target");
  mkdirSync(target);
  symlinkSync(target, path.join(f.base, "link"));
  for (const root of [path.join(f.base, "link"), path.join(f.base, "link", "nested", "out")]) {
    for (const tool of ["codex_task_start", "codex_image_generate"]) {
      const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: root }, createTransport: () => new FakeAppServer(completingScript([imgItem("g", f.png), turnCompleted()])) });
      const { job_id } = (await h.call(tool, { prompt: "draw", cwd: f.base })).structuredContent as { job_id: string };
      const done = await waitDone(h, job_id);
      assert.equal((done.error as any).code, "OUTPUT_ROOT_UNAVAILABLE", `${tool} ${root}`);
      assert.deepEqual(readdirSync(target), [], "nothing written through the symlink");
    }
  }
  // A regular file where the root should be is also refused.
  writeFileSync(path.join(f.base, "file-root"), "x");
  const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: path.join(f.base, "file-root") }, createTransport: () => new FakeAppServer(completingScript([imgItem("g", f.png), turnCompleted()])) });
  const { job_id } = (await h.call("codex_task_start", { prompt: "draw", cwd: f.base })).structuredContent as { job_id: string };
  assert.equal(((await waitDone(h, job_id)).error as any).code, "OUTPUT_ROOT_UNAVAILABLE");
});

for (const mode of ["cancel", "deadline"] as const) {
  test(`codex_task_start image saving (${mode}) at the after-copy gate: BUSY until settled, owned output removed`, async () => {
    const f = taskImageFixture();
    const g = gate();
    const h = handler({
      wallMs: mode === "deadline" ? 150 : 60_000,
      env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out },
      createTransport: () => new FakeAppServer(completingScript([imgItem("g1", f.png), imgItem("g2", f.jpg), turnCompleted()])),
      imageAfterStep: async (s) => (s === "copy" ? g.hold() : undefined),
    });
    const { job_id } = (await h.call("codex_task_start", { prompt: "draw", cwd: f.base })).structuredContent as { job_id: string };
    await g.entered;
    assert.equal(ownedEntries(f.out).length, 1);
    if (mode === "cancel") assert.equal(((await h.call("codex_task_cancel", { job_id })).structuredContent as any).cancel_requested, true);
    else await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.jobs.active, job_id);
    g.release();
    const done = await waitDone(h, job_id);
    assert.equal((done.error as any).code, mode === "cancel" ? "CANCELLED" : "TIMEOUT");
    assert.equal(done.result, null);
    assert.deepEqual(ownedEntries(f.out), []);
    assert.equal(h.jobs.active, undefined);
  });
}

test("launch policy regression: task with images still uses cwd-only workspace-write, on-request, no network, tmp excluded", async () => {
  const f = taskImageFixture();
  const fake = new FakeAppServer(completingScript([imgItem("g1", f.png), turnCompleted()]));
  const h = handler({ env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out }, createTransport: () => fake });
  const { job_id } = (await h.call("codex_task_start", { prompt: "draw", cwd: f.base })).structuredContent as { job_id: string };
  assert.equal((await waitDone(h, job_id)).state, "succeeded");
  const ts = fake.received.find((m) => m.method === "thread/start")!.params!;
  const tr = fake.received.find((m) => m.method === "turn/start")!.params!;
  assert.deepEqual(Object.keys(ts).sort(), ["approvalPolicy", "approvalsReviewer", "cwd", "model", "sandbox"]);
  assert.equal(ts.sandbox, "workspace-write");
  assert.equal(tr.approvalPolicy, "on-request");
  assert.deepEqual(tr.sandboxPolicy, { type: "workspaceWrite", writableRoots: [f.base], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
  assert.ok(!JSON.stringify(fake.received).includes(f.out), "output root never sent to Codex");
});

// --- Bridge mode (CODEX_BRIDGE_MODE) ---

const GENERAL_TOOLS = ["codex_status", "codex_task_start", "codex_task_status", "codex_task_cancel", "codex_image_generate"];
const IMAGE_ONLY_TOOLS = ["codex_status", "codex_image_generate", "codex_task_status", "codex_task_cancel"];
const INVALID_MODES = ["", " ", "\t", "\n", "Image-Only", "IMAGE-ONLY", "image_only", "imageonly", " image-only", "image-only ", "general\n", "GENERAL", "task", "SECRET-mode"];
const code = (r: ToolResult): string => (r.structuredContent as any).error.code;
const jobCount = (h: ToolHandler): number => (h.jobs as any).jobs.size;
const serverJs = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "dist", "src", "server.js");

test("bridge mode resolver: unset is general; only exact general|image-only accepted; invalid gives a static diagnostic", () => {
  assert.deepEqual(resolveBridgeMode({}), { ok: true, mode: "general", source: "default" });
  assert.deepEqual(resolveBridgeMode({ CODEX_BRIDGE_MODE: "general" }), { ok: true, mode: "general", source: "env" });
  assert.deepEqual(resolveBridgeMode(IMAGE_ONLY), { ok: true, mode: "image-only", source: "env" });
  assert.match(BRIDGE_MODE_INVALID_MESSAGE, /CODEX_BRIDGE_MODE/);
  for (const bad of INVALID_MODES) {
    assert.deepEqual(resolveBridgeMode({ CODEX_BRIDGE_MODE: bad }), { ok: false, message: BRIDGE_MODE_INVALID_MESSAGE }, JSON.stringify(bad));
    assert.throws(() => handler({ env: { CODEX_BRIDGE_MODE: bad } }), (e: unknown) => e instanceof BridgeModeError && e.message === BRIDGE_MODE_INVALID_MESSAGE);
  }
});

test("tool discovery: unset and general list the existing five definitions unchanged; image-only exactly four existing ones", () => {
  for (const env of [{}, { CODEX_BRIDGE_MODE: "general" }]) {
    const tools = handler({ env }).listTools();
    assert.deepEqual(tools.map((t) => t.name), GENERAL_TOOLS);
    for (const t of tools) assert.equal(t, TOOLS[t.name as keyof typeof TOOLS]);
  }
  const io = handler({ env: IMAGE_ONLY }).listTools();
  assert.deepEqual(io.map((t) => t.name), IMAGE_ONLY_TOOLS);
  for (const t of io) assert.equal(t, TOOLS[t.name as keyof typeof TOOLS]);
  assert.ok(Object.isFrozen(MODE_TOOLS) && Object.isFrozen(MODE_TOOLS.general) && Object.isFrozen(MODE_TOOLS["image-only"]));
});

test("codex_status reports bridge_mode and 0.2.2 in every mode; default and custom roots unchanged", async () => {
  for (const [env, mode] of [[{}, "general"], [{ CODEX_BRIDGE_MODE: "general" }, "general"], [IMAGE_ONLY, "image-only"]] as const) {
    const s = (await handler({ env }).call("codex_status", {})).structuredContent as Record<string, any>;
    assert.equal(s.bridge_mode, mode);
    assert.equal(s.server_version, "0.2.2");
    assert.equal(s.active_job_id, null);
    assert.equal(s.launch.sandbox, "workspace-write");
    assert.equal(s.launch.approval_policy, "on-request");
    assert.deepEqual(s.image_output, { root: path.join(os.homedir(), "codex-images"), source: "default", error: null });
  }
  const o = (await handler({ env: { ...IMAGE_ONLY, CODEX_IMAGE_OUTPUT_ROOT: "/abs/out" } }).call("codex_status", {})).structuredContent as Record<string, any>;
  assert.deepEqual(o.image_output, { root: "/abs/out", source: "env", error: null });
  assert.equal((await handler({ env: IMAGE_ONLY }).call("codex_status", { bridge_mode: "general" })).isError, true, "no per-call override");
});

test("bridge mode is fixed for the handler's lifetime: env mutation and assignment do not change it", async () => {
  const env: NodeJS.ProcessEnv = { ...IMAGE_ONLY };
  const h = handler({ env });
  env.CODEX_BRIDGE_MODE = "general";
  assert.equal(h.mode, "image-only");
  assert.deepEqual(h.listTools().map((t) => t.name), IMAGE_ONLY_TOOLS);
  delete env.CODEX_BRIDGE_MODE;
  assert.equal(((await h.call("codex_status", {})).structuredContent as any).bridge_mode, "image-only");
  assert.throws(() => ((h as any).mode = "general"), TypeError);
  assert.equal(h.mode, "image-only");
  assert.equal(code(await h.call("codex_task_start", { prompt: "x", cwd: tmp() })), "TOOL_DISABLED");

  const genv: NodeJS.ProcessEnv = {};
  const g = handler({ env: genv });
  genv.CODEX_BRIDGE_MODE = "image-only";
  assert.equal(g.mode, "general");
  assert.deepEqual(g.listTools().map((t) => t.name), GENERAL_TOOLS);
});

test("image-only: direct codex_task_start is TOOL_DISABLED before argument, output-root or cwd checks; no job, no spawn, no writes", async () => {
  for (const root of [undefined, "", "rel/SECRET"]) {
    let spawned = 0;
    const env: NodeJS.ProcessEnv = root === undefined ? { ...IMAGE_ONLY } : { ...IMAGE_ONLY, CODEX_IMAGE_OUTPUT_ROOT: root };
    const h = handler({ env, createTransport: () => (spawned++, new FakeAppServer(completingScript([turnCompleted()]))) });
    const cwd = tmp();
    const argsList: unknown[] = [
      { prompt: "x", cwd },
      undefined,
      null,
      {},
      [],
      "SECRET",
      { prompt: "", cwd },
      { prompt: "x".repeat(MAX_PROMPT_CHARS + 1), cwd },
      { prompt: "x", cwd: "relative/SECRET" },
      { prompt: "x", cwd: "/" },
      { prompt: "x", cwd, model: "SECRET" },
    ];
    for (const args of argsList) {
      const r = await h.call("codex_task_start", args);
      assert.equal(r.isError, true);
      assert.equal(code(r), "TOOL_DISABLED", `${String(root)} ${JSON.stringify(args)?.slice(0, 40)}`);
      assert.ok(!JSON.stringify(r).includes("SECRET"));
    }
    assert.equal(h.jobs.active, undefined);
    assert.equal(jobCount(h), 0, "no job allocated");
    assert.equal(spawned, 0, "nothing spawned");
    assert.deepEqual(readdirSync(cwd), []);
    // The exposed image tool keeps its normal validation order.
    if (root !== undefined) assert.equal(code(await h.call("codex_image_generate", { prompt: "x", cwd })), "OUTPUT_ROOT_INVALID");
  }
});

test("private start re-checks the name at runtime: hidden kind TOOL_DISABLED, unknown names UNKNOWN_TOOL; no job, no spawn", async () => {
  for (const env of [{}, IMAGE_ONLY]) {
    let spawned = 0;
    const h = handler({ env, createTransport: () => (spawned++, new FakeAppServer()) });
    const cwd = tmp();
    const start = (n: string): Promise<ToolResult> => (h as any).start(n, { prompt: "x", cwd });
    const unknown = ["bogus", "__proto__", "constructor", "toString", "hasOwnProperty", "", "codex_task_start ", "CODEX_TASK_START", "codex_image_edit"];
    for (const n of unknown) {
      assert.equal(code(await h.call(n, { prompt: "x", cwd })), "UNKNOWN_TOOL", n);
      assert.equal(code(await start(n)), "UNKNOWN_TOOL", n);
    }
    for (const n of ["codex_status", "codex_task_status", "codex_task_cancel"]) assert.equal(code(await start(n)), "UNKNOWN_TOOL", n);
    if (h.mode === "image-only") assert.equal(code(await start("codex_task_start")), "TOOL_DISABLED");
    assert.equal(jobCount(h), 0);
    assert.equal(spawned, 0);
  }
});

test("MCP protocol (image-only): tools/list has four tools; hidden and unknown calls refused with no job and no spawn", async () => {
  let spawned = 0;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const { server, handler: h } = buildServer({ versionProbe: okProbe, capabilityProbe: caps, env: { ...IMAGE_ONLY }, createTransport: () => (spawned++, new FakeAppServer()) });
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), IMAGE_ONLY_TOOLS);
  const cwd = tmp();
  const hidden = (await client.callTool({ name: "codex_task_start", arguments: { prompt: "x", cwd } })) as ToolResult;
  assert.equal(hidden.isError, true);
  assert.equal(code(hidden), "TOOL_DISABLED");
  assert.equal(code((await client.callTool({ name: "codex_task_start", arguments: { bad: 1 } })) as ToolResult), "TOOL_DISABLED");
  assert.equal(code((await client.callTool({ name: "codex_shell", arguments: {} })) as ToolResult), "UNKNOWN_TOOL");
  const s = (await client.callTool({ name: "codex_status", arguments: {} })).structuredContent as any;
  assert.equal(s.bridge_mode, "image-only");
  assert.equal(s.active_job_id, null);
  assert.equal(spawned, 0);
  assert.equal(h.jobs.active, undefined);
  assert.equal(jobCount(h), 0);
  await client.close();
  await server.close();
});

test("image-only: an internally started task-kind job is UNKNOWN_JOB to poll and cancel; never cancelled, result never exposed", async () => {
  const h = handler({ env: { ...IMAGE_ONLY }, wallMs: 60_000 });
  const g = gate();
  let signal: AbortSignal | undefined;
  const view = h.jobs.start("task", async (s) => {
    signal = s;
    await g.hold();
    return { text: "SECRET-result" };
  })!;
  await g.entered;
  const id = view.job_id;
  for (const tool of ["codex_task_status", "codex_task_cancel"]) {
    const r = await h.call(tool, { job_id: id });
    assert.equal(code(r), "UNKNOWN_JOB", tool);
  }
  assert.equal(signal!.aborted, false, "cancel did not reach the hidden job");
  assert.equal(h.jobs.get(id)?.state, "running");
  assert.equal(((await h.call("codex_status", {})).structuredContent as any).active_job_id, null);
  // The single-active policy still holds.
  assert.equal(code(await h.call("codex_image_generate", { prompt: "x", cwd: tmp() })), "BUSY");
  g.release();
  for (let i = 0; i < 200 && h.jobs.get(id)?.state === "running"; i++) await sleep(5);
  assert.equal(h.jobs.get(id)?.state, "succeeded");
  for (const tool of ["codex_task_status", "codex_task_cancel"]) {
    const r = await h.call(tool, { job_id: id });
    assert.equal(code(r), "UNKNOWN_JOB", tool);
    assert.ok(!JSON.stringify(r).includes("SECRET"));
  }
  assert.deepEqual(h.jobs.get(id)?.result, { text: "SECRET-result" }, "internal state untouched");

  // The same kind stays visible in general mode.
  const gen = handler({ wallMs: 60_000 });
  const gv = gen.jobs.start("task", async () => ({ text: "ok" }))!;
  for (let i = 0; i < 200 && gen.jobs.get(gv.job_id)?.state === "running"; i++) await sleep(5);
  assert.equal(((await gen.call("codex_task_status", { job_id: gv.job_id })).structuredContent as any).state, "succeeded");
});

test("server CLI: invalid CODEX_BRIDGE_MODE exits before any transport with a static stderr diagnostic and no stdout", () => {
  for (const bad of ["", " ", "image_only", "SECRET-mode"]) {
    const r = spawnSync(process.execPath, [serverJs], {
      input: "",
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "", HOME: tmp(), CODEX_BIN: "/nonexistent/codex", CODEX_BRIDGE_MODE: bad },
    });
    assert.equal(r.status, EXIT_INVALID_BRIDGE_MODE, JSON.stringify(bad));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `codex-claude-bridge: ${BRIDGE_MODE_INVALID_MESSAGE}; not starting.\n`);
    assert.ok(!r.stderr.includes("SECRET"));
  }
});

test("server CLI (image-only) over real stdio: tools/list has four tools, codex_task_start is TOOL_DISABLED", { timeout: 20_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { CODEX_BRIDGE_MODE: "image-only", CODEX_BIN: "/nonexistent/codex", HOME: tmp() },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), IMAGE_ONLY_TOOLS);
    assert.equal(code((await client.callTool({ name: "codex_task_start", arguments: { prompt: "x", cwd: tmp() } })) as ToolResult), "TOOL_DISABLED");
    const s = (await client.callTool({ name: "codex_status", arguments: {} })).structuredContent as any;
    assert.equal(s.bridge_mode, "image-only");
    assert.equal(s.active_job_id, null);
  } finally {
    await client.close();
  }
});
