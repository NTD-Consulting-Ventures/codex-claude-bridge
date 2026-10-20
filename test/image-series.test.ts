// NON-LIVE: image-series resilience (0.3.0) against scripted fake app-servers.
// Covers per-job timeouts, the opt-in queue, codex_task_wait, progress and
// partial results, thread-folder salvage, reference images, aspect, error
// hints and the bounded codex_status. No Codex process is spawned here.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { errorHint } from "../src/error-hints.js";
import { ImageSink, imageInfo } from "../src/image-service.js";
import { registrationEnv, addArgs } from "../src/install.js";
import { JobManager, MAX_QUEUED_JOBS } from "../src/jobs.js";
import { JOB_TIMEOUT_INVALID_MESSAGE, resolveJobTimeout, resolveRegisteredJobTimeout } from "../src/limits.js";
import { localImageInputFromClientRequest, type ImageProtocolCapabilities } from "../src/protocol-capabilities.js";
import { ToolHandler, type ServerDeps } from "../src/server.js";
import { TaskError } from "../src/session.js";
import { probeCapabilities } from "../src/status.js";
import { agentMessage, completingScript, defaultReply, FakeAppServer, THREAD_ID, TURN_ID, turnCompleted, type Msg } from "./fake-app-server.js";

type Any = Record<string, any>;
const okProbe = async () => ({ ok: true, stdout: "codex-cli 0.162.1\n" });
const caps = async () => ({
  plugins: { available: true, reason: null, items: [{ name: "demo", enabled: true, installed: true }], truncated: false, has_more: false },
  mcp_servers: { available: true, reason: null, items: [], truncated: false, has_more: false },
});
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-series-")));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** A minimal PNG: signature, IHDR of the given size and color type (fill byte as CRC), IEND. */
function pngOf(width: number, height: number, colorType = 2, fill = 1): Buffer {
  const ihdr = Buffer.alloc(25, fill);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, IEND]);
}
const PNG_A = pngOf(1774, 887, 2, 1);
const PNG_B = pngOf(1254, 1254, 6, 2);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00]), Buffer.alloc(16, 3), Buffer.from([0xff, 0xd9])]);

const imgItem = (savedPath: string | null, id = "g", status = "completed"): object => ({
  method: "item/completed",
  params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "imageGeneration", id, result: "", status, savedPath } },
});
const delta = (): object => ({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "m", delta: "…" } });

interface Fixture {
  base: string;
  home: string;
  out: string;
  a: string;
  b: string;
}
function fixture(): Fixture {
  const base = tmp();
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const a = path.join(home, "generated_images", "a.png");
  const b = path.join(home, "generated_images", "b.png");
  writeFileSync(a, PNG_A);
  writeFileSync(b, PNG_B);
  return { base, home, out: path.join(base, "out"), a, b };
}

const REFS: ImageProtocolCapabilities = { nativeInstructions: true, continuity: false, resumeExcludeTurns: false, setName: false, localImageInput: true, reason: "no_thread_resume" };

function handler(f: Fixture, deps: ServerDeps = {}, env: Record<string, string> = {}): ToolHandler {
  return new ToolHandler({
    versionProbe: okProbe,
    capabilityProbe: caps,
    wallMs: 5_000,
    env: { CODEX_HOME: f.home, CODEX_IMAGE_OUTPUT_ROOT: f.out, ...env },
    ...deps,
  });
}

/** Sends `frames` after turn/start; the turn completes only if a turn/completed frame is among them. */
function scripted(frames: object[], delayMs = 1): FakeAppServer {
  return new FakeAppServer({
    onRequest(msg, ctx) {
      const r = defaultReply(msg);
      if (msg.method === "turn/start") setTimeout(() => frames.forEach((fr) => ctx.send(fr)), delayMs);
      return r;
    },
  });
}

async function call(h: ToolHandler, name: string, args: unknown): Promise<Any> {
  const r = await h.call(name, args);
  return { ...(r.structuredContent as Any), isError: r.isError === true };
}

async function settle(h: ToolHandler, id: string): Promise<Any> {
  for (let i = 0; i < 400; i++) {
    const r = await call(h, "codex_task_status", { job_id: id });
    if (r.state !== "running" && r.state !== "queued") return r;
    await sleep(5);
  }
  throw new Error("job did not finish");
}

// ---------------------------------------------------------------- limits

test("job timeout: server resolution is lenient and reports the issue; installer resolution is strict", () => {
  assert.deepEqual(resolveJobTimeout({}), { seconds: 300, source: "default", issue: null });
  assert.deepEqual(resolveJobTimeout({ CODEX_TASK_WALL_SECONDS: "600" }), { seconds: 600, source: "env", issue: null });
  assert.deepEqual(resolveJobTimeout({ CODEX_TASK_WALL_SECONDS: "5000" }), { seconds: 900, source: "env", issue: "capped" });
  for (const bad of ["", " ", "abc", "-5", "0", "1.5"]) {
    assert.deepEqual(resolveJobTimeout({ CODEX_TASK_WALL_SECONDS: bad }), { seconds: 300, source: "default", issue: "invalid" }, bad);
  }
  assert.deepEqual(resolveRegisteredJobTimeout({}), { ok: true, persist: undefined });
  assert.deepEqual(resolveRegisteredJobTimeout({ CODEX_TASK_WALL_SECONDS: "600" }), { ok: true, persist: 600 });
  for (const bad of ["", "9", "901", "0600", "600 ", "1e3", "abc"]) {
    assert.deepEqual(resolveRegisteredJobTimeout({ CODEX_TASK_WALL_SECONDS: bad }), { ok: false, reason: JOB_TIMEOUT_INVALID_MESSAGE }, bad);
  }
  assert.ok(!JOB_TIMEOUT_INVALID_MESSAGE.includes("abc"));
});

test("registration persists CODEX_TASK_WALL_SECONDS only when given, after the name", () => {
  assert.deepEqual(registrationEnv("/c/codex", "/o"), { CODEX_BIN: "/c/codex", CODEX_IMAGE_OUTPUT_ROOT: "/o" });
  assert.deepEqual(registrationEnv("/c/codex", "/o", undefined, 600), { CODEX_BIN: "/c/codex", CODEX_IMAGE_OUTPUT_ROOT: "/o", CODEX_TASK_WALL_SECONDS: "600" });
  assert.deepEqual(addArgs("/n", "/s.js", "/c/codex", "/o", "image-only", 600), [
    "mcp", "add", "--transport", "stdio", "--scope", "user", "codex-claude-bridge",
    "-e", "CODEX_BIN=/c/codex", "-e", "CODEX_IMAGE_OUTPUT_ROOT=/o", "-e", "CODEX_BRIDGE_MODE=image-only", "-e", "CODEX_TASK_WALL_SECONDS=600",
    "--", "/n", "/s.js",
  ]);
  assert.throws(() => registrationEnv("/c/codex", "/o", undefined, 5), TypeError);
});

test("timeout_s: bounded per-job limit is accepted, reported, and invalid values are refused before any job", async () => {
  const f = fixture();
  let spawned = 0;
  const h = handler(f, { createTransport: () => (spawned++, scripted([imgItem(f.a), turnCompleted()])) });
  for (const bad of [5, 901, 1.5, "60", null]) {
    const r = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base, timeout_s: bad });
    assert.equal(r.error.code, "INVALID_ARGUMENTS", String(bad));
  }
  assert.equal(spawned, 0);
  const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base, timeout_s: 600 });
  assert.equal(s.timeout_s, 600);
  const done = await settle(h, s.job_id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.timeout_s, 600);
});

test("a per-job wall limit overrides the manager default", async () => {
  const jobs = new JobManager(60_000);
  const v = jobs.start("image", (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new TaskError("TIMEOUT")))), undefined, { wallMs: 30 });
  assert.ok(v);
  const done = await jobs.wait(v.job_id, 2_000);
  assert.equal(done?.state, "failed");
  assert.equal(done?.error?.code, "TIMEOUT");
  assert.equal(done?.timeout_s, 0);
});

// ---------------------------------------------------------------- queue and wait

test("queue: FIFO behind the running job, deadline starts when it runs, cancel while queued, bounded, cleared by shutdown", async () => {
  const jobs = new JobManager(60_000);
  const order: string[] = [];
  let release!: () => void;
  const first = jobs.start("task", async () => {
    order.push("first");
    await new Promise<void>((r) => (release = r));
    return "a";
  });
  assert.ok(first);
  assert.equal(jobs.start("task", async () => "x"), null, "BUSY without queue");
  const second = jobs.start("task", async () => (order.push("second"), "b"), undefined, { queue: true, wallMs: 1_000 });
  const third = jobs.start("task", async () => (order.push("third"), "c"), undefined, { queue: true });
  assert.equal(second?.state, "queued");
  assert.equal(second?.started_at, null);
  assert.equal(second?.queue_position, 1);
  assert.equal(third?.queue_position, 2);
  assert.deepEqual(jobs.queued, [second!.job_id, third!.job_id]);
  assert.equal(jobs.cancel(third!.job_id), true);
  assert.equal(jobs.get(third!.job_id)?.state, "cancelled");
  assert.equal(jobs.get(third!.job_id)?.error?.code, "CANCELLED");
  await sleep(1_100);
  assert.equal(jobs.get(second!.job_id)?.state, "queued", "its 1 s deadline has not started while queued");
  release();
  const done = await jobs.wait(second!.job_id, 2_000);
  assert.equal(done?.state, "succeeded");
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(jobs.active, undefined);

  // Bounded queue.
  let hold!: () => void;
  const blocker = jobs.start("task", () => new Promise((r) => (hold = () => r("x"))));
  assert.ok(blocker);
  const queued = Array.from({ length: MAX_QUEUED_JOBS }, () => jobs.start("task", async () => "q", undefined, { queue: true }));
  assert.ok(queued.every((q) => q?.state === "queued"));
  assert.equal(jobs.queueFull, true);
  assert.equal(jobs.start("task", async () => "q", undefined, { queue: true }), null);
  // Shutdown cancels every queued job and starts none of them.
  const stop = jobs.shutdown(50);
  for (const q of queued) assert.equal(jobs.get(q!.job_id)?.state, "cancelled");
  hold();
  await stop;
  assert.equal(jobs.queued.length, 0);
});

test("server queue: queue:true queues an image job behind a running one; BUSY without it; not combinable with session_handle", async () => {
  const f = fixture();
  const servers: FakeAppServer[] = [];
  let holdFirst = true;
  const h = handler(f, {
    createTransport: () => {
      const frames = holdFirst ? [imgItem(f.a)] : [imgItem(f.b), turnCompleted()];
      holdFirst = false;
      const s = scripted(frames);
      servers.push(s);
      return s;
    },
  });
  const first = await call(h, "codex_image_generate", { prompt: "one", cwd: f.base });
  assert.equal(first.state, "running");
  assert.equal((await call(h, "codex_image_generate", { prompt: "two", cwd: f.base })).error.code, "BUSY");
  const bad = await call(h, "codex_image_generate", { prompt: "two", cwd: f.base, queue: true, session_handle: "cis_" + "a".repeat(32) });
  assert.equal(bad.error.code, "INVALID_ARGUMENTS");
  const second = await call(h, "codex_image_generate", { prompt: "two", cwd: f.base, queue: true });
  assert.equal(second.state, "queued");
  assert.equal(second.queue_position, 1);
  const st = await call(h, "codex_status", {});
  assert.equal(st.active_job_id, first.job_id);
  assert.deepEqual(st.queued_job_ids, [second.job_id]);
  assert.equal(servers.length, 1, "the queued job has not spawned anything");
  // Cancel only once the first job's image has been saved.
  for (let i = 0; i < 200 && (await call(h, "codex_task_status", { job_id: first.job_id })).progress?.files_so_far?.length !== 1; i++) await sleep(5);
  await call(h, "codex_task_cancel", { job_id: first.job_id });
  const done = await settle(h, second.job_id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.result.files[0].sha256, sha(PNG_B));
  assert.equal((await settle(h, first.job_id)).partial_files.length, 1, "the cancelled first job kept its image");
});

test("codex_task_wait: returns when the job finishes, or after max_wait_s while it runs; validates and hides like status", async () => {
  const f = fixture();
  let complete = false;
  const h = handler(f, { createTransport: () => scripted(complete ? [imgItem(f.a), turnCompleted()] : [], 1) });
  const running = await call(h, "codex_image_generate", { prompt: "slow", cwd: f.base });
  const w1 = await call(h, "codex_task_wait", { job_id: running.job_id, max_wait_s: 1 });
  assert.equal(w1.state, "running");
  assert.ok(w1.waited_ms >= 900 && w1.waited_ms < 3_000, String(w1.waited_ms));
  assert.equal(w1.progress.phase, "turn");
  await call(h, "codex_task_cancel", { job_id: running.job_id });
  await settle(h, running.job_id);
  complete = true;
  const fast = await call(h, "codex_image_generate", { prompt: "fast", cwd: f.base });
  const w2 = await call(h, "codex_task_wait", { job_id: fast.job_id });
  assert.equal(w2.state, "succeeded");
  assert.ok(w2.waited_ms < 3_000);
  for (const bad of [{}, { job_id: fast.job_id, max_wait_s: 0 }, { job_id: fast.job_id, max_wait_s: 121 }, { job_id: fast.job_id, extra: 1 }]) {
    assert.equal((await call(h, "codex_task_wait", bad)).error.code, "INVALID_ARGUMENTS", JSON.stringify(bad));
  }
  assert.equal((await call(h, "codex_task_wait", { job_id: "00000000-0000-4000-8000-000000000000" })).error.code, "UNKNOWN_JOB");
  // image-only: a task-kind job stays invisible to wait as well.
  const io = handler(f, {}, { CODEX_BRIDGE_MODE: "image-only" });
  const t = io.jobs.start("task", async () => "secret");
  assert.equal((await call(io, "codex_task_wait", { job_id: t!.job_id })).error.code, "UNKNOWN_JOB");
});

// ---------------------------------------------------------------- progress and partial results

test("progress: files are saved while the job runs (files_so_far); a timeout keeps them as partial_files with timing", async () => {
  const f = fixture();
  const h = handler(f, { wallMs: 400, createTransport: () => scripted([delta(), imgItem(f.a, "g1")]) });
  const s = await call(h, "codex_task_start", { prompt: "three pictures", cwd: f.base });
  let running: Any | undefined;
  for (let i = 0; i < 100; i++) {
    running = await call(h, "codex_task_status", { job_id: s.job_id });
    if (running.progress?.files_so_far?.length === 1) break;
    await sleep(5);
  }
  assert.equal(running!.state, "running");
  assert.equal(running!.progress.images_completed, 1);
  assert.equal(running!.progress.files_so_far[0].sha256, sha(PNG_A));
  assert.equal(typeof running!.progress.first_model_event_ms, "number");
  const done = await settle(h, s.job_id);
  assert.equal(done.state, "failed");
  assert.equal(done.error.code, "TIMEOUT");
  assert.equal(done.error.retryable, true);
  assert.equal(done.error.likely_cause, "slow_generation");
  assert.equal(done.error.diagnostic.images_completed, 1);
  assert.equal(done.partial_files.length, 1);
  assert.equal(done.partial_files[0].path, running!.progress.files_so_far[0].path, "the same copy, not a second one");
  assert.deepEqual([done.partial_files[0].width, done.partial_files[0].height, done.partial_files[0].has_alpha], [1774, 887, false]);
  assert.equal(done.progress, undefined);
});

test("a timeout while Codex keeps reconnecting is reported as network (field case: unstable hotspot)", async () => {
  const f = fixture();
  // As captured from codex-cli 0.162.1 without network: the echoed user message, retries, a transport warning.
  const userMsg = { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "userMessage", id: "u", content: [] } } };
  const retry = (n: string): object => ({
    method: "error",
    params: { threadId: THREAD_ID, turnId: TURN_ID, willRetry: true, error: { message: `Reconnecting... ${n}`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } },
  });
  const warning = { method: "warning", params: { threadId: THREAD_ID, message: "Falling back from WebSockets to HTTPS transport." } };
  const h = handler(f, { wallMs: 250, createTransport: () => scripted([userMsg, retry("2/5"), warning, retry("waiting for network")]) });
  const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base });
  const done = await settle(h, s.job_id);
  assert.equal(done.error.code, "TIMEOUT");
  assert.equal(done.error.likely_cause, "network");
  assert.equal(done.error.diagnostic.first_model_event_ms, null, "the echoed user message and the warning are not model activity");
  assert.equal(done.error.diagnostic.retried_errors, 2);
  assert.equal(done.error.diagnostic.last_retry_error_info, "responseStreamDisconnected");
});

test("a timeout with no model event at all is reported as no_model_response", async () => {
  const f = fixture();
  const h = handler(f, { wallMs: 150, createTransport: () => scripted([]) });
  const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base });
  const done = await settle(h, s.job_id);
  assert.equal(done.error.code, "TIMEOUT");
  assert.equal(done.error.likely_cause, "no_model_response");
  assert.equal(done.error.diagnostic.first_model_event_ms, null);
  assert.deepEqual(done.partial_files, []);
});

test("TURN_FAILED (network) after one of two images: the finished one is kept, retryable network hint", async () => {
  const f = fixture();
  const h = handler(f, {
    createTransport: () =>
      scripted([imgItem(f.a, "g1"), { method: "error", params: { threadId: THREAD_ID, turnId: TURN_ID, willRetry: true, error: { message: "stream disconnected" } } }, turnCompleted("failed", { message: "stream disconnected before completion", codexErrorInfo: "responseStreamDisconnected" })]),
  });
  const s = await call(h, "codex_task_start", { prompt: "two pictures", cwd: f.base });
  const done = await settle(h, s.job_id);
  assert.equal(done.error.code, "TURN_FAILED");
  assert.equal(done.error.likely_cause, "network");
  assert.equal(done.error.retryable, true);
  assert.equal(done.error.diagnostic.retried_errors, 1);
  assert.deepEqual(done.partial_files.map((x: Any) => x.sha256), [sha(PNG_A)]);
  const st = await call(h, "codex_status", {});
  assert.deepEqual(st.last_job, { job_id: s.job_id, kind: "task", state: "failed", finished_at: done.finished_at, error_code: "TURN_FAILED", likely_cause: "network", partial_files: 1 });
});

test("thread-folder salvage: an image saved for the thread but never reported is recovered by location and time only", async () => {
  const f = fixture();
  const dir = path.join(f.home, "generated_images", THREAD_ID);
  mkdirSync(dir);
  const old = path.join(dir, "old.png");
  writeFileSync(old, pngOf(10, 10, 2, 9));
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(old, past, past);
  const h = handler(f, {
    wallMs: 300,
    createTransport: () =>
      new FakeAppServer({
        onRequest(msg, ctx) {
          // Codex saves two images (one reported, one not) and the turn never completes.
          if (msg.method === "turn/start") {
            setTimeout(() => {
              writeFileSync(path.join(dir, "exec-1.png"), PNG_A);
              writeFileSync(path.join(dir, "exec-2.png"), PNG_B);
              // Still being written: no IEND yet, so it is not taken.
              writeFileSync(path.join(dir, "exec-3.png"), PNG_A.subarray(0, PNG_A.length - 12));
              ctx.send(imgItem(path.join(dir, "exec-1.png"), "g1"));
            }, 5);
          }
          return defaultReply(msg);
        },
      }),
  });
  const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base });
  const done = await settle(h, s.job_id);
  assert.equal(done.error.code, "TIMEOUT");
  assert.deepEqual(
    done.partial_files.map((x: Any) => [x.index, x.sha256, x.source ?? "native"]),
    [[0, sha(PNG_A), "native"], [1, sha(PNG_B), "thread_folder"]],
    "reported image once, unreported one by location, older file ignored",
  );
});

test("nothing is salvaged during handler shutdown (the process is exiting); a plain cancel does salvage", async () => {
  for (const how of ["shutdown", "cancel"] as const) {
    const f = fixture();
    const dir = path.join(f.home, "generated_images", THREAD_ID);
    mkdirSync(dir);
    const h = handler(f, {
      wallMs: 60_000,
      createTransport: () =>
        new FakeAppServer({
          onRequest(msg) {
            // Codex saved an image for the thread but has not reported it yet.
            if (msg.method === "turn/start") writeFileSync(path.join(dir, "exec-1.png"), PNG_A);
            return defaultReply(msg);
          },
        }),
    });
    const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base });
    await sleep(30);
    if (how === "shutdown") await h.shutdown(async () => undefined, 1_000);
    else await call(h, "codex_task_cancel", { job_id: s.job_id });
    const done = await settle(h, s.job_id);
    assert.equal(done.state, "cancelled", how);
    assert.equal(done.partial_files.length, how === "shutdown" ? 0 : 1, how);
  }
});

// ---------------------------------------------------------------- reference images

test("reference images: verified inside cwd, sent as localImage after the text, reported in the start response", async () => {
  const f = fixture();
  mkdirSync(path.join(f.base, "refs"));
  writeFileSync(path.join(f.base, "refs", "cast.jpg"), JPEG);
  writeFileSync(path.join(f.base, "page-3.png"), PNG_B);
  const servers: FakeAppServer[] = [];
  const h = handler(f, { imageCapabilities: async () => REFS, createTransport: () => (servers.push(scripted([imgItem(f.a), turnCompleted()])), servers.at(-1)!) });
  const s = await call(h, "codex_image_generate", { prompt: "page 3 again, only the sky darker", cwd: f.base, reference_images: ["refs/cast.jpg", path.join(f.base, "page-3.png")] });
  assert.equal(s.isError, false, JSON.stringify(s));
  assert.equal(s.reference_images, 2);
  assert.equal((await settle(h, s.job_id)).state, "succeeded");
  const ts = servers[0]!.received.find((m: Msg) => m.method === "turn/start")!;
  assert.deepEqual(ts.params!.input, [
    { type: "text", text: "page 3 again, only the sky darker", text_elements: [] },
    { type: "localImage", path: path.join(f.base, "refs", "cast.jpg") },
    { type: "localImage", path: path.join(f.base, "page-3.png") },
  ]);
  const ths = servers[0]!.received.find((m: Msg) => m.method === "thread/start")!;
  assert.match(ths.params!.developerInstructions as string, /attached to a user message are visual references/);
  // codex_task_start takes them too.
  const t = await call(h, "codex_task_start", { prompt: "use the cast", cwd: f.base, reference_images: ["refs/cast.jpg"] });
  assert.equal(t.reference_images, 1);
  await settle(h, t.job_id);
  assert.deepEqual(servers[1]!.received.find((m: Msg) => m.method === "turn/start")!.params!.input, [
    { type: "text", text: "use the cast", text_elements: [] },
    { type: "localImage", path: path.join(f.base, "refs", "cast.jpg") },
  ]);
  const st = await call(h, "codex_status", {});
  assert.equal(st.reference_images.support, "available");
  assert.equal(st.image_edit_enabled, true);
});

test("reference images are rejected with a fixed reason before any job; unsupported schema is refused without spawning", async () => {
  const f = fixture();
  const outside = tmp();
  writeFileSync(path.join(outside, "x.png"), PNG_A);
  writeFileSync(path.join(f.base, "ok.png"), PNG_A);
  writeFileSync(path.join(f.base, "text.png"), "not an image");
  symlinkSync(path.join(f.base, "ok.png"), path.join(f.base, "link.png"));
  let spawned = 0;
  const h = handler(f, { imageCapabilities: async () => REFS, createTransport: () => (spawned++, scripted([turnCompleted()])) });
  const cases: [unknown, string, string?][] = [
    [["../" + path.basename(outside) + "/x.png"], "REFERENCE_IMAGE_INVALID", "outside_cwd"],
    [[path.join(outside, "x.png")], "REFERENCE_IMAGE_INVALID", "outside_cwd"],
    [["missing.png"], "REFERENCE_IMAGE_INVALID", "not_found"],
    [["text.png"], "REFERENCE_IMAGE_INVALID", "not_png_or_jpeg"],
    [["link.png"], "REFERENCE_IMAGE_INVALID", "symlink"],
    [["ok.png", "./ok.png"], "REFERENCE_IMAGE_INVALID", "duplicate"],
    [["."], "REFERENCE_IMAGE_INVALID", "outside_cwd"],
    [[], "INVALID_ARGUMENTS"],
    [Array.from({ length: 9 }, () => "ok.png"), "INVALID_ARGUMENTS"],
    ["ok.png", "INVALID_ARGUMENTS"],
  ];
  for (const [refs, code, reason] of cases) {
    const r = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base, reference_images: refs });
    assert.equal(r.error.code, code, JSON.stringify(refs));
    if (reason) assert.equal(r.error.reason, reason, JSON.stringify(refs));
  }
  assert.equal(spawned, 0);
  // Fixture transports have no launcher schema: localImage support is unproven, so nothing starts.
  const plain = handler(f, { createTransport: () => (spawned++, scripted([turnCompleted()])) });
  for (const tool of ["codex_image_generate", "codex_task_start"]) {
    const r = await call(plain, tool, { prompt: "x", cwd: f.base, reference_images: ["ok.png"] });
    assert.equal(r.error.code, "REFERENCE_IMAGES_UNSUPPORTED", tool);
  }
  assert.equal(spawned, 0);
  assert.equal(plain.jobs.active, undefined);
});

test("localImage support is read from the turn/start params schema (shape of the codex-cli 0.162.1 schema)", async () => {
  const userInput = (variants: object[]) => ({
    oneOf: [{ properties: { method: { enum: ["turn/start"], type: "string" }, params: { $ref: "#/definitions/TurnStartParams" } } }],
    definitions: {
      TurnStartParams: { type: "object", properties: { threadId: { type: "string" }, input: { type: "array", items: { $ref: "#/definitions/UserInput" } } } },
      UserInput: { oneOf: variants },
    },
  });
  const text = { properties: { text: { type: "string" }, type: { enum: ["text"], title: "TextUserInputType", type: "string" } }, required: ["text", "type"], type: "object" };
  const local = { properties: { detail: { default: null }, path: { type: "string" }, type: { enum: ["localImage"], title: "LocalImageUserInputType", type: "string" } }, required: ["path", "type"], type: "object" };
  assert.equal(await localImageInputFromClientRequest(userInput([text, local])), true);
  assert.equal(await localImageInputFromClientRequest(userInput([text])), false);
  assert.equal(await localImageInputFromClientRequest(userInput([text, { ...local, properties: { ...local.properties, path: { type: "integer" } } }])), false);
  // External params file, as older generators emit it.
  const ext = { oneOf: [{ properties: { method: { const: "turn/start" }, params: { $ref: "#/definitions/TurnStartParams" } } }] };
  const file = { type: "object", properties: { input: { type: "array", items: { $ref: "#/definitions/UserInput" } } }, definitions: { UserInput: { oneOf: [local] } } };
  assert.equal(await localImageInputFromClientRequest(ext, async (n) => (n === "TurnStartParams" ? file : null)), true);
  assert.equal(await localImageInputFromClientRequest({}), false);
});

// ---------------------------------------------------------------- aspect and file metadata

test("aspect adds one fixed phrase to the image prompt; unknown values are refused", async () => {
  const f = fixture();
  const servers: FakeAppServer[] = [];
  const h = handler(f, { createTransport: () => (servers.push(scripted([imgItem(f.a), turnCompleted()])), servers.at(-1)!) });
  assert.equal((await call(h, "codex_image_generate", { prompt: "x", cwd: f.base, aspect: "7:5" })).error.code, "INVALID_ARGUMENTS");
  const s = await call(h, "codex_image_generate", { prompt: "a meadow", cwd: f.base, aspect: "2:1" });
  const done = await settle(h, s.job_id);
  const text = (servers[0]!.received.find((m: Msg) => m.method === "turn/start")!.params!.input as Any[])[0]!.text as string;
  assert.match(text, /a meadow\n\nOutput format: wide landscape, aspect ratio 2:1\.$/);
  assert.deepEqual([done.result.files[0].width, done.result.files[0].height], [1774, 887]);
});

test("imageInfo reads PNG/JPEG headers and alpha, and degrades to null", () => {
  assert.deepEqual(imageInfo(PNG_A, "png"), { width: 1774, height: 887, has_alpha: false });
  assert.deepEqual(imageInfo(PNG_B, "png"), { width: 1254, height: 1254, has_alpha: true });
  assert.deepEqual(imageInfo(JPEG, "jpeg"), { width: 768, height: 512, has_alpha: false });
  assert.deepEqual(imageInfo(Buffer.from([0x89, 0x50]), "png"), { width: null, height: null, has_alpha: null });
  assert.deepEqual(imageInfo(Buffer.from([0xff, 0xd8, 0x00, 0x00]), "jpeg"), { width: null, height: null, has_alpha: null });
});

// ---------------------------------------------------------------- hints and status

test("error hints map typed errors to retryable / likely_cause from enums only", () => {
  assert.deepEqual(errorHint("TIMEOUT", { phase: "initialize" }), { retryable: true, likely_cause: "startup" });
  assert.deepEqual(errorHint("TIMEOUT", { phase: "turn", first_model_event_ms: null }), { retryable: true, likely_cause: "no_model_response" });
  assert.deepEqual(errorHint("TIMEOUT", { phase: "turn", first_model_event_ms: 90_000, last_event_ms_ago: 5_000 }), { retryable: true, likely_cause: "slow_generation" });
  assert.deepEqual(errorHint("TIMEOUT", { phase: "turn", first_model_event_ms: 9_000, last_event_ms_ago: 120_000 }), { retryable: true, likely_cause: "stalled" });
  assert.deepEqual(errorHint("TIMEOUT", { phase: "turn", images_completed: 1, last_retry_error_info: "responseStreamDisconnected" }), { retryable: true, likely_cause: "network" });
  assert.deepEqual(errorHint("TIMEOUT", { phase: "turn", last_retry_message_class: "server_error" }), { retryable: true, likely_cause: "server" });
  assert.deepEqual(errorHint("TURN_FAILED", { phase: "turn", turn_message_class: "network" }), { retryable: true, likely_cause: "network" });
  assert.deepEqual(errorHint("TURN_FAILED", { phase: "turn", codex_error_info: "serverOverloaded" }), { retryable: true, likely_cause: "server" });
  assert.deepEqual(errorHint("TURN_FAILED", { phase: "turn", codex_error_info: "cyberPolicy" }), { retryable: false, likely_cause: "content_policy" });
  assert.deepEqual(errorHint("TURN_FAILED", { phase: "turn" }), { retryable: false, likely_cause: "unknown" });
  assert.deepEqual(errorHint("QUOTA_EXCEEDED", { phase: "turn", codex_error_info: "rateLimitExceeded" }), { retryable: true, likely_cause: "rate_limit" });
  assert.deepEqual(errorHint("QUOTA_EXCEEDED", { phase: "turn", codex_error_info: "usageLimitExceeded" }), { retryable: false, likely_cause: "quota" });
  assert.deepEqual(errorHint("CANCELLED"), { retryable: false, likely_cause: "cancelled" });
  assert.deepEqual(errorHint("AUTH_REQUIRED"), { retryable: false, likely_cause: "auth" });
});

test("codex_status reports limits, env issues and the reference-image bounds", async () => {
  const f = fixture();
  const s = await call(handler(f, { wallMs: undefined as never }, { CODEX_TASK_WALL_SECONDS: "5000" }), "codex_status", {});
  assert.deepEqual(s.limits, {
    job_timeout_s: { default: 900, source: "env", env_issue: "capped", min: 10, max: 900 },
    max_images_per_job: 8,
    max_queued_jobs: 8,
    retained_jobs: 20,
    max_wait_s: 120,
  });
  assert.deepEqual(s.reference_images, { support: "unknown", max_count: 8, max_bytes_each: 20 * 1024 * 1024, max_total_bytes: 64 * 1024 * 1024 });
  assert.equal(s.last_job, null);
  assert.deepEqual(s.queued_job_ids, []);
  const bad = await call(handler(f, { wallMs: undefined as never }, { CODEX_TASK_WALL_SECONDS: "soon" }), "codex_status", {});
  assert.deepEqual(bad.limits.job_timeout_s, { default: 300, source: "default", env_issue: "invalid", min: 10, max: 900 });
});

test("codex_status shows the last good listing as stale when the probe fails later", async () => {
  const f = fixture();
  let fail = false;
  const h = handler(f, {
    capabilityProbe: async () =>
      fail
        ? { plugins: { available: false, reason: "initialize failed", items: [], truncated: false, has_more: null }, mcp_servers: { available: false, reason: "initialize failed", items: [], truncated: false, has_more: null } }
        : await caps(),
  });
  const first = await call(h, "codex_status", {});
  assert.equal(first.plugins.stale, undefined);
  fail = true;
  const second = await call(h, "codex_status", {});
  assert.equal(second.plugins.available, true);
  assert.equal(second.plugins.stale, true);
  assert.equal(second.plugins.reason, "initialize failed");
  assert.deepEqual(second.plugins.items, [{ name: "demo", enabled: true, installed: true }]);
  assert.equal(typeof second.plugins.cached_at, "string");
});

test("the plugin / MCP probe shares one budget: a silent app-server cannot hold codex_status", async () => {
  const fake = new FakeAppServer({ onRequest: () => undefined });
  const t0 = Date.now();
  const r = await probeCapabilities(() => fake, 80);
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms`);
  assert.equal(r.plugins.available, false);
  assert.equal(r.plugins.reason, "initialize failed");
  assert.equal(fake.killed, true);
});

test("the plain text-only task still succeeds with no files and no partial_files field", async () => {
  const f = fixture();
  const h = handler(f, { createTransport: () => new FakeAppServer(completingScript([agentMessage("done"), turnCompleted()])) });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: f.base });
  const done = await settle(h, s.job_id);
  assert.deepEqual(done.result, { text: "done", text_truncated: false, image_items: 0, files: [] });
  assert.equal(done.partial_files, undefined);
  assert.deepEqual(readdirSync(f.base).sort(), ["codex-home"]);
});

// ---------------------------------------------------------------- review fixes

function gate(): { entered: Promise<void>; release: () => void; hold: () => Promise<void> } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const released = new Promise<void>((r) => (release = r));
  return { entered, release, hold: async () => (enter(), await released) };
}

test("a failure decided before the deadline stays the root cause when the deadline fires during salvage", async () => {
  const f = fixture();
  const g = gate();
  const h = handler(f, {
    wallMs: 150,
    imageAfterStep: async (step) => (step === "copy" ? g.hold() : undefined),
    createTransport: () => scripted([imgItem(f.a, "g1"), turnCompleted("failed", { message: "blocked", codexErrorInfo: "cyberPolicy" })]),
  });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: f.base });
  await g.entered;
  await sleep(250);
  assert.equal(h.jobs.active, s.job_id, "still BUSY while the copy is held past the deadline");
  g.release();
  const done = await settle(h, s.job_id);
  assert.equal(done.error.code, "TURN_FAILED");
  assert.equal(done.error.likely_cause, "content_policy");
  assert.equal(done.error.retryable, false);
  assert.equal(done.partial_files.length, 1);
});

test("a deadline after the turn finished is a saving-phase timeout, not a startup problem", async () => {
  const f = fixture();
  const g = gate();
  const h = handler(f, {
    wallMs: 150,
    versionProbe: async () => (await g.hold(), { ok: true, stdout: "codex-cli 0.162.1\n" }),
    createTransport: () => scripted([imgItem(f.a), turnCompleted()]),
  });
  const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base });
  await g.entered;
  await sleep(200);
  g.release();
  const done = await settle(h, s.job_id);
  assert.equal(done.error.code, "TIMEOUT");
  assert.deepEqual(done.error.diagnostic, { phase: "saving" });
  assert.equal(done.error.likely_cause, "slow_generation");
  assert.equal(done.partial_files.length, 1);
});

test("an image reported a moment before its file is complete is copied on the retry", async () => {
  const f = fixture();
  const late = path.join(f.home, "generated_images", "late.png");
  const h = handler(f, {
    createTransport: () =>
      new FakeAppServer({
        onRequest(msg, ctx) {
          if (msg.method === "turn/start") {
            setTimeout(() => ctx.send(imgItem(late)), 1);
            setTimeout(() => (writeFileSync(late, PNG_A), ctx.send(turnCompleted())), 30);
          }
          return defaultReply(msg);
        },
      }),
  });
  const s = await call(h, "codex_image_generate", { prompt: "x", cwd: f.base });
  const done = await settle(h, s.job_id);
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  assert.equal(done.result.files[0].sha256, sha(PNG_A));
});

test("a queued image job creates its session only when it starts", async () => {
  const f = fixture();
  let n = 0;
  const h = handler(f, {
    imageCapabilities: async () => ({ ...REFS, continuity: true, reason: null }),
    createTransport: () => (n++ === 0 ? scripted([]) : scripted([imgItem(f.b), turnCompleted()])),
  });
  const first = await call(h, "codex_image_generate", { prompt: "one", cwd: f.base });
  assert.match(first.session_handle, /^cis_/);
  const queued = await call(h, "codex_image_generate", { prompt: "two", cwd: f.base, queue: true });
  assert.equal(queued.state, "queued");
  assert.equal(queued.session_handle, null);
  assert.deepEqual(queued.session, { continuity: "available", handle_pending: true });
  assert.equal(h.sessions.size, 1, "no session reserved for the queued job");
  await call(h, "codex_task_cancel", { job_id: first.job_id });
  const done = await settle(h, queued.job_id);
  assert.equal(done.state, "succeeded");
  assert.match(done.result.session_handle, /^cis_/);
  assert.equal(done.session.session_handle, done.result.session_handle);
  assert.equal(done.session.next_action, "reuse_only_for_related_edits");
});

test("the image sink writes nothing once stopped (shutdown), salvage included", async () => {
  const f = fixture();
  const sink = new ImageSink(f.out, [f.home], { stop: () => true });
  sink.add(f.a);
  await sink.salvage();
  await sink.salvageThreadFolder(f.home, THREAD_ID, Date.now());
  await sink.finish();
  assert.deepEqual(sink.files(), []);
  assert.deepEqual(readdirSync(f.base).sort(), ["codex-home"], "no output directory created");
});

test("thread-folder salvage of a resumed thread takes only files from this turn on", async () => {
  const f = fixture();
  const dir = path.join(f.home, "generated_images", THREAD_ID);
  mkdirSync(dir);
  const prev = path.join(dir, "exec-prev.png");
  writeFileSync(prev, PNG_A);
  const since = Date.now();
  const before = new Date(since - 1_000);
  utimesSync(prev, before, before);
  const strict = new ImageSink(f.out, [f.home]);
  await strict.salvageThreadFolder(f.home, THREAD_ID, since, 0);
  assert.deepEqual(strict.files(), [], "the previous turn's image is not taken");
  const lenient = new ImageSink(f.out, [f.home]);
  await lenient.salvageThreadFolder(f.home, THREAD_ID, since);
  assert.equal(lenient.files().length, 1, "a new thread tolerates clock skew");
});
