#!/usr/bin/env node
// Parent-controlled LIVE diagnostic. Not run by `npm test`. Requires `npm run build`.
//
//   node scripts/diagnose.mjs                # initialize + model/list + thread/start only
//   node scripts/diagnose.mjs --task-error   # additionally ONE tiny PONG turn
//
// Spawns the installed app-server exactly like a task (resolved CODEX_BIN,
// explicit cwd = fresh git-ignored .smoke/<uuid>/workspace) and sends the same
// params the server uses, including the same model/list default selection
// (src/model-select.ts; fails with MODEL_UNAVAILABLE, no fallback). Without a flag no turn is started and nothing is
// generated. Output goes to stdout only; nothing is written to disk.
//
// thread_start reports the effective ThreadStartResponse policy as fixed
// enums/booleans/counts only (no paths) and the same threadPolicyMismatch()
// verdict the server uses; on a mismatch no turn is started.
//
// --task-error starts exactly ONE no-tools "reply PONG" turn: no retry, no
// image, no config overrides, no config/auth file reads. Any server-initiated
// request (approval, plugin/MCP elicitation, tool call) is denied and ends the
// turn. If the turn fails, its TurnError.message is printed ONLY after
// redaction (src/turn-error.ts: tokens, bearer, sk-, JWTs, emails, URLs,
// paths, ids; bounded to 512 chars) next to the whitelisted enums.

import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClientError, CodexRpcClient } from "../dist/src/codex-client.js";
import { resolveCodexBin, spawnAppServer, terminateAllAppServers } from "../dist/src/process-transport.js";
import {
  initializeParams,
  requestKind,
  summarizeTurnError,
  threadPolicyMismatch,
  threadStartParams,
  turnStartParams,
} from "../dist/src/session.js";
import { selectDefaultModel } from "../dist/src/model-select.js";
import { SERVER_VERSION } from "../dist/src/status.js";
import { redactMessage } from "../dist/src/turn-error.js";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--task-error")) {
  process.stderr.write("usage: diagnose.mjs [--task-error]\n");
  process.exit(64);
}
const taskError = args.includes("--task-error");
const TURN_TIMEOUT_MS = 120_000;
const PONG_PROMPT =
  "This is a connectivity check. Reply with exactly the single word PONG. " +
  "Do not run any commands, do not read or edit any files, and do not call any tools, plugins or MCP servers.";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = path.join(root, ".smoke", randomUUID(), "workspace");
mkdirSync(cwd, { recursive: true, mode: 0o700 });
const realCwd = realpathSync(cwd);

const bin = resolveCodexBin();
const report = { codex_bin_source: bin.source, codex_bin_valid: bin.path !== null, steps: [] };

const SAFE_ENUM = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const enumOrNull = (v) => (typeof v === "string" && SAFE_ENUM.test(v) ? v : null);
const boolOrNull = (v) => (typeof v === "boolean" ? v : null);

/** Effective thread policy without paths: enums, booleans and root counts relative to cwd. */
function policySummary(r, expectedCwd) {
  const sb = r?.sandbox && typeof r.sandbox === "object" ? r.sandbox : {};
  const roots = Array.isArray(sb.writableRoots) ? sb.writableRoots : null;
  return {
    cwd_matches: r?.cwd === expectedCwd,
    approval_policy: enumOrNull(r?.approvalPolicy),
    approvals_reviewer: enumOrNull(r?.approvalsReviewer),
    sandbox_type: enumOrNull(sb.type),
    network_access: boolOrNull(sb.networkAccess),
    exclude_slash_tmp: boolOrNull(sb.excludeSlashTmp),
    exclude_tmpdir_env_var: boolOrNull(sb.excludeTmpdirEnvVar),
    writable_roots_count: roots ? roots.length : null,
    writable_roots_equal_cwd: roots ? roots.filter((x) => x === expectedCwd).length : null,
    policy_mismatch: threadPolicyMismatch(r, expectedCwd),
  };
}

function safe(e) {
  if (e instanceof CodexClientError) return { kind: e.kind, ...(e.rpc ?? {}) };
  return { kind: "unexpected" };
}

async function step(name, fn) {
  try {
    const summary = await fn();
    report.steps.push({ step: name, ok: true, ...summary });
    return true;
  } catch (e) {
    report.steps.push({ step: name, ok: false, ...safe(e) });
    return false;
  }
}

/** One turn, no retry. Resolves with enums + the redacted message; never the raw message. */
function pongTurn(client, threadId) {
  return new Promise((resolve, reject) => {
    let turnId;
    let retried = 0;
    let lastFatal;
    let settled = false;
    const early = new Map();
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const describe = (status, error) => {
      const out = { turn_status: status };
      const raw = error ?? lastFatal;
      if (raw) {
        const s = summarizeTurnError(raw);
        out.codex_error_info = s.info;
        out.turn_message_class = s.messageClass;
        if (s.httpStatus) out.http_status = s.httpStatus;
        out.error_message_redacted = redactMessage(raw.message);
      }
      if (retried > 0) out.retried_errors = retried;
      return out;
    };
    const timer = setTimeout(() => finish(describe("diagnostic_timeout")), TURN_TIMEOUT_MS);
    client.onServerRequest((method) => finish({ turn_status: "aborted_server_request", request_kind: requestKind(method) }));
    client.onClose((kind) => finish({ turn_status: "connection_closed", kind }));
    client.onNotification((method, p) => {
      if (!p || typeof p !== "object" || p.threadId !== threadId) return;
      if (method === "error" && (turnId === undefined || p.turnId === turnId)) {
        if (p.willRetry === true) retried = Math.min(retried + 1, 1000);
        else if (p.error && typeof p.error === "object") lastFatal = p.error;
      } else if (method === "turn/completed" && typeof p.turn?.id === "string") {
        const err = p.turn.error && typeof p.turn.error === "object" ? p.turn.error : undefined;
        const done = () => finish(describe(String(p.turn.status).slice(0, 32), err));
        if (turnId === p.turn.id) done();
        else if (early.size < 16) early.set(p.turn.id, done);
      }
    });
    client
      .request("turn/start", turnStartParams(threadId, PONG_PROMPT, realCwd), { timeoutMs: 30_000 })
      .then((r) => {
        if (typeof r?.turn?.id !== "string") throw new CodexClientError("protocol");
        turnId = r.turn.id;
        early.get(turnId)?.();
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
  });
}

if (bin.path !== null) {
  const client = new CodexRpcClient(spawnAppServer({ bin: bin.path, cwd: realCwd }));
  let threadId;
  try {
    const inited = await step("initialize", async () => {
      await client.request("initialize", initializeParams(SERVER_VERSION), { timeoutMs: 20_000 });
      client.notify("initialized");
      return {};
    });
    let model;
    if (inited) {
      await step("model_select", async () => {
        const sel = await selectDefaultModel((m, p) => client.request(m, p, { timeoutMs: 30_000 }));
        if (!sel.ok) return { ok: false, task_code: "MODEL_UNAVAILABLE", model_selection: sel.reason };
        model = sel.model;
        return { model_id: sel.model };
      });
    }
    if (model !== undefined) {
      await step("thread_start", async () => {
        const r = await client.request("thread/start", threadStartParams(realCwd, model), { timeoutMs: 30_000 });
        const policy = policySummary(r, realCwd);
        const present = typeof r?.thread?.id === "string";
        // Same gate as the server: no turn on a mismatched effective policy.
        if (present && policy.policy_mismatch === null) threadId = r.thread.id;
        return { ok: present && policy.policy_mismatch === null, thread_id_present: present, policy };
      });
    }
    if (taskError && threadId !== undefined) {
      await step("task_turn", () => pongTurn(client, threadId));
      const t = report.steps.at(-1);
      if (t.ok && t.turn_status !== "completed") t.ok = false;
    }
  } finally {
    client.kill("closed");
    await terminateAllAppServers();
  }
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.steps.length > 0 && report.steps.every((s) => s.ok) ? 0 : 1;
