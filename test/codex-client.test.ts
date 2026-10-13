// NON-LIVE protocol fixture tests. No Codex process is spawned; a fake
// in-memory transport replays hand-written JSON-RPC frames.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CodexClientError,
  CodexRpcClient,
  DENIED_CODE,
  LineFramer,
  type CodexTransport,
} from "../src/codex-client.js";

class FakeTransport implements CodexTransport {
  written: string[] = [];
  killed = 0;
  closed = 0;
  failWrites = false;
  private out: ((c: string) => void) | undefined;
  private err: ((c: string) => void) | undefined;
  private exit: (() => void) | undefined;
  write(d: string): void {
    if (this.failWrites) throw new Error("EPIPE secret-path /Users/x/.codex/auth.json");
    this.written.push(d);
  }
  onStdout(cb: (c: string) => void): void { this.out = cb; }
  onStderr(cb: (c: string) => void): void { this.err = cb; }
  onExit(cb: () => void): void { this.exit = cb; }
  kill(): void { this.killed++; }
  close(): void { this.closed++; }
  emit(obj: unknown): void { this.out?.(JSON.stringify(obj) + "\n"); }
  raw(s: string): void { this.out?.(s); }
  stderr(s: string): void { this.err?.(s); }
  doExit(): void { this.exit?.(); }
  sent(i: number): Record<string, unknown> { return JSON.parse(this.written[i] ?? "null") as Record<string, unknown>; }
}

function isKind(kind: string) {
  return (e: unknown) => e instanceof CodexClientError && e.kind === kind;
}

test("framing: splits lines across chunks and strips CR", () => {
  const f = new LineFramer(100);
  assert.deepEqual(f.push('{"a"'), []);
  assert.deepEqual(f.push(':1}\r\n{"b":2}\n\n'), ['{"a":1}', '{"b":2}']);
  assert.equal(f.hasPartial, false);
});

test("framing: oversized frame is rejected", () => {
  const f = new LineFramer(8);
  assert.throws(() => f.push("123456789"), isKind("bounds"));
  const g = new LineFramer(8);
  g.push("1234");
  assert.throws(() => g.push("56789\n"), isKind("bounds"));
});

test("request/response roundtrip, frames are newline-terminated JSON-RPC", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("initialize", { clientInfo: { name: "x" } });
  const sent = t.sent(0);
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "initialize");
  assert.ok(t.written[0]?.endsWith("\n"));
  t.emit({ jsonrpc: "2.0", id: sent.id, result: { ok: true } });
  assert.deepEqual(await p, { ok: true });
  assert.equal(c.pendingCount, 0);
});

test("injection: newline in params cannot break framing", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  void c.request("m", { text: 'x"}\n{"jsonrpc":"2.0","id":99,"method":"evil"}' }).catch(() => {});
  assert.equal(t.written.length, 1);
  assert.equal(t.written[0]?.split("\n").length, 2);
  assert.equal(t.sent(0).method, "m");
  c.close();
});

test("unknown server requests are denied with an error and no action", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  for (const method of ["execCommandApproval", "applyPatchApproval", "item/commandExecution/requestApproval", "totally/unknown"]) {
    t.emit({ jsonrpc: "2.0", id: `srv-${method}`, method, params: { command: ["rm", "-rf", "/"] } });
  }
  assert.equal(t.written.length, 4);
  for (const line of t.written) {
    const m = JSON.parse(line) as { error?: { code: number }; result?: unknown };
    assert.equal(m.error?.code, DENIED_CODE);
    assert.equal("result" in m, false);
  }
  assert.equal(c.stats.deniedServerRequests, 4);
  assert.equal(c.isClosed, false);
});

test("notifications reach handler; handler throw does not break client", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const seen: string[] = [];
  c.onNotification((m) => { seen.push(m); throw new Error("boom"); });
  t.emit({ jsonrpc: "2.0", method: "turn/started", params: {} });
  t.emit({ jsonrpc: "2.0", method: "item/completed", params: {} });
  assert.deepEqual(seen, ["turn/started", "item/completed"]);
  assert.equal(c.isClosed, false);
});

test("auth error is classified and message is sanitized", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("thread/start");
  t.emit({ jsonrpc: "2.0", id: t.sent(0).id, error: { code: -32000, message: "Not logged in. token=sk-SECRET at /Users/niki/.codex/auth.json" } });
  await assert.rejects(p, (e: unknown) => {
    assert.ok(isKind("auth_required")(e));
    const msg = (e as Error).message;
    assert.ok(!msg.includes("SECRET") && !msg.includes(".codex"));
    return true;
  });
});

test("quota error is classified", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("turn/start");
  t.emit({ jsonrpc: "2.0", id: t.sent(0).id, error: { code: -32000, message: "You've hit your usage limit" } });
  await assert.rejects(p, isKind("quota_exceeded"));
  const p2 = c.request("turn/start");
  t.emit({ jsonrpc: "2.0", id: t.sent(1).id, error: { code: 429, message: "x" } });
  await assert.rejects(p2, isKind("quota_exceeded"));
});

test("generic server error keeps no raw text", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("x");
  t.emit({ jsonrpc: "2.0", id: t.sent(0).id, error: { code: -32603, message: "internal /secret/path" } });
  await assert.rejects(p, (e: unknown) => isKind("server_error")(e) && !(e as Error).message.includes("secret"));
});

test("no retries: failed request is sent exactly once", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("turn/start");
  t.emit({ jsonrpc: "2.0", id: t.sent(0).id, error: { code: -32000, message: "overloaded" } });
  await assert.rejects(p);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.written.length, 1);
});

test("late response after timeout is ignored; timeout kills transport", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("slow", undefined, { timeoutMs: 10 });
  await assert.rejects(p, isKind("timeout"));
  assert.equal(t.killed, 1);
  assert.equal(c.isClosed, true);
  t.emit({ jsonrpc: "2.0", id: 1, result: "late" });
  await assert.rejects(c.request("again"), isKind("closed"));
  assert.equal(t.written.length, 1);
});

test("unknown/duplicate response ids are counted as late and ignored", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("a");
  const id = t.sent(0).id;
  t.emit({ jsonrpc: "2.0", id, result: 1 });
  t.emit({ jsonrpc: "2.0", id, result: 2 });
  t.emit({ jsonrpc: "2.0", id: 12345, result: 3 });
  assert.equal(await p, 1);
  assert.equal(c.stats.lateResponses, 2);
  assert.equal(c.isClosed, false);
});

test("abort rejects and kills; already-aborted signal never sends", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const ac = new AbortController();
  const p = c.request("turn/start", {}, { signal: ac.signal });
  const other = c.request("other");
  ac.abort();
  await assert.rejects(p, isKind("aborted"));
  await assert.rejects(other, isKind("aborted"));
  assert.equal(t.killed, 1);

  const t2 = new FakeTransport();
  const c2 = new CodexRpcClient(t2);
  const ac2 = new AbortController();
  ac2.abort();
  await assert.rejects(c2.request("x", {}, { signal: ac2.signal }), isKind("aborted"));
  assert.equal(t2.written.length, 0);
});

test("pending request bound", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t, { maxPendingRequests: 2 });
  const a = c.request("a");
  const b = c.request("b");
  await assert.rejects(c.request("c"), isKind("bounds"));
  assert.equal(t.written.length, 2);
  c.close();
  await assert.rejects(a, isKind("closed"));
  await assert.rejects(b, isKind("closed"));
});

test("outgoing frame bound", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t, { maxFrameBytes: 64 });
  await assert.rejects(c.request("m", { big: "x".repeat(100) }), isKind("bounds"));
  assert.equal(t.written.length, 0);
});

test("incoming frame bound fails closed", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t, { maxFrameBytes: 64 });
  const p = c.request("m");
  t.raw("x".repeat(65));
  await assert.rejects(p, isKind("bounds"));
  assert.equal(t.killed, 1);
});

test("total stdout bound fails closed", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t, { maxTotalStdoutBytes: 200 });
  const p = c.request("m");
  for (let i = 0; i < 10; i++) t.emit({ jsonrpc: "2.0", method: "n", params: { i } });
  await assert.rejects(p, isKind("bounds"));
  assert.equal(c.isClosed, true);
});

test("stderr beyond its bound is dropped (counted only), never surfaced, and does not fail the request", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t, { maxStderrBytes: 16 });
  const p = c.request("m");
  t.stderr("short");
  t.stderr("token=sk-SECRET-LEAK-xxxxxxxxxxxx");
  assert.equal(c.isClosed, false);
  assert.equal(c.stats.droppedStderrBytes, "token=sk-SECRET-LEAK-xxxxxxxxxxxx".length);
  assert.ok(!JSON.stringify(c.stats).includes("SECRET"));
  t.emit({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(await p, { ok: true });
});

test("default bounds: real-shaped ~1.3 MiB imageGeneration notification passes; over 8 MiB fails closed", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const seen: unknown[] = [];
  c.onNotification((m, params) => seen.push([m, params]));
  const p = c.request("m");
  // Inline base64 in `result` (schema ImageGenerationThreadItem). The live smoke PNG was 940955 bytes
  // (~1.2 MiB as one frame); 1030000 bytes gives a ~1.31 MiB frame with headroom above it.
  const b64 = Buffer.alloc(1_030_000, 7).toString("base64");
  const item = { type: "imageGeneration", id: "ig_1", status: "completed", revisedPrompt: null, result: b64, savedPath: "/h/.codex/generated_images/t/x.png" };
  const line = JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", turnId: "u", item } }) + "\n";
  assert.ok(line.length > 1.2 * 1024 * 1024 && line.length < 1.4 * 1024 * 1024);
  // Delivered in pipe-sized chunks like a real child stdout.
  for (let i = 0; i < line.length; i += 65_536) t.raw(line.slice(i, i + 65_536));
  assert.equal(c.isClosed, false);
  assert.equal(seen.length, 1);
  t.emit({ jsonrpc: "2.0", id: 1, result: {} });
  await p;

  const t2 = new FakeTransport();
  const c2 = new CodexRpcClient(t2);
  const p2 = c2.request("m");
  const huge = "x".repeat(8 * 1024 * 1024 + 1);
  for (let i = 0; i < huge.length; i += 1_048_576) t2.raw(huge.slice(i, i + 1_048_576));
  await assert.rejects(p2, isKind("bounds"));
  assert.equal(t2.killed, 1);
});

test("invalid JSON frame fails closed with protocol error", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("m");
  t.raw("not json\n");
  await assert.rejects(p, isKind("protocol"));
  assert.equal(c.stats.invalidFrames, 1);
});

test("non-object / malformed messages fail closed", async () => {
  for (const bad of ["[1,2]\n", "42\n", '{"jsonrpc":"2.0","id":1}\n']) {
    const t = new FakeTransport();
    const c = new CodexRpcClient(t);
    const p = c.request("m");
    t.raw(bad);
    await assert.rejects(p, isKind("protocol"));
  }
});

test("peer exit rejects pending as closed; clean close is idempotent", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const p = c.request("m");
  t.doExit();
  await assert.rejects(p, isKind("closed"));
  c.close();
  c.close();
  assert.equal(t.closed, 1);
  assert.equal(t.killed, 0);
});

test("write failure yields sanitized closed error", async () => {
  const t = new FakeTransport();
  t.failWrites = true;
  const c = new CodexRpcClient(t);
  await assert.rejects(c.request("m"), (e: unknown) => isKind("closed")(e) && !(e as Error).message.includes("auth.json"));
});

test("response racing with abort settles exactly once", async () => {
  const t = new FakeTransport();
  const c = new CodexRpcClient(t);
  const ac = new AbortController();
  const p = c.request("m", {}, { signal: ac.signal });
  t.emit({ jsonrpc: "2.0", id: t.sent(0).id, result: "ok" });
  ac.abort();
  assert.equal(await p, "ok");
  assert.equal(t.killed, 0);
});
