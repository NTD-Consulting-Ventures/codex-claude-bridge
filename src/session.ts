// One delegated Codex turn on a NEW thread in a fresh app-server process.
//
// Lifecycle: initialize -> initialized -> model/list -> thread/start -> verify
// the effective thread policy -> turn/start -> wait for the matching
// turn/completed. Native approval/sandbox stay in force: the thread is started
// with sandbox "workspace-write", approvalPolicy "on-request" and approvals
// routed to "user"; the turn sends an explicit workspaceWrite sandboxPolicy
// whose only writable root is the validated cwd (no network, /tmp and $TMPDIR
// excluded). Writes inside cwd need no approval. Every server-initiated
// request (elevated approval, elicitation, auth refresh, dynamic tool, user
// input) is denied and fails the job with a typed error; this bridge never
// answers one on the user's behalf. No retries anywhere.

import { CodexClientError, CodexRpcClient, type CodexTransport, type RpcErrorInfo } from "./codex-client.js";
import { assertCwdShape } from "./cwd.js";
import { selectDefaultModel, type ModelSelectionFailure } from "./model-select.js";
import { classifyTurnMessage, httpStatusFromMessage, type TurnMessageClass } from "./turn-error.js";

export const APPROVAL_POLICY = "on-request" as const;
export const APPROVALS_REVIEWER = "user" as const;
export const SANDBOX_MODE = "workspace-write" as const;
export const MAX_RESULT_TEXT_BYTES = 64 * 1024;
const MAX_IMAGE_ITEMS = 8;
const RPC_TIMEOUT_MS = 30_000;

// Request params, exactly per the codex-cli 0.156.0 schema. Shared with
// scripts/diagnose.mjs so the diagnostic sends byte-identical requests.

/** InitializeParams: both capability booleans are schema-defaulted to false; sent explicitly. */
export function initializeParams(clientVersion: string): Record<string, unknown> {
  return {
    clientInfo: { name: "codex-image-mcp", title: "codex-claude-bridge", version: clientVersion },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
}

/**
 * ThreadStartParams: new thread, native on-request approvals reviewed by the
 * user (never auto_review), workspace-write sandbox, and the model id this
 * app-server's own `model/list` advertises as default (src/model-select.ts).
 * Nothing else: no `config`, no writable-root or network overrides.
 */
export function threadStartParams(cwd: string, model: string): Record<string, unknown> {
  return { cwd: assertCwdShape(cwd), model, approvalPolicy: APPROVAL_POLICY, approvalsReviewer: APPROVALS_REVIEWER, sandbox: SANDBOX_MODE };
}

/**
 * SandboxPolicy (WorkspaceWriteSandboxPolicy) for the turn: cwd is the only
 * writable root, no network, and the schema-defaulted /tmp and $TMPDIR roots
 * are explicitly excluded.
 */
export function workspaceWritePolicy(cwd: string): Record<string, unknown> {
  return { type: "workspaceWrite", writableRoots: [assertCwdShape(cwd)], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
}

/**
 * TurnStartParams: one UserInput text item (`text_elements`, snake_case,
 * serde-default, sent as []), plus explicit cwd, approval policy, reviewer and
 * sandbox policy so nothing is inherited from config for this turn.
 */
export function turnStartParams(threadId: string, prompt: string, cwd: string): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    cwd: assertCwdShape(cwd),
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: APPROVALS_REVIEWER,
    sandboxPolicy: workspaceWritePolicy(cwd),
  };
}

/** Which part of the effective ThreadStartResponse policy did not match. Fixed enums only. */
export type PolicyMismatch =
  | "invalid_shape"
  | "cwd"
  | "approval_policy"
  | "approvals_reviewer"
  | "sandbox_type"
  | "network_access"
  | "writable_roots";

/**
 * Verifies the effective policy a ThreadStartResponse reports (codex-cli
 * 0.156.0: required `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`)
 * before any turn is started. Returns null when acceptable.
 *
 * Accepted semantics: `sandbox` must be workspaceWrite with networkAccess
 * false (schema default when absent) and writableRoots empty (cwd is the
 * implicit root) or exactly [cwd]; any other root is an ambient broadening
 * from config and is rejected. excludeSlashTmp / excludeTmpdirEnvVar are not
 * settable through thread/start (SandboxMode only), so their thread-level
 * values are tolerated and overridden by the explicit turn sandboxPolicy.
 */
export function threadPolicyMismatch(resp: unknown, cwd: string): PolicyMismatch | null {
  const r = obj(resp);
  const sb = obj(r?.sandbox);
  if (!r || !sb || typeof sb.type !== "string") return "invalid_shape";
  if (r.cwd !== cwd) return "cwd";
  const thread = obj(r.thread);
  if (thread && "cwd" in thread && thread.cwd !== cwd) return "cwd";
  if (r.approvalPolicy !== APPROVAL_POLICY) return "approval_policy";
  if (r.approvalsReviewer !== APPROVALS_REVIEWER) return "approvals_reviewer";
  if (sb.type !== "workspaceWrite") return "sandbox_type";
  if (sb.networkAccess !== undefined && sb.networkAccess !== false) return "network_access";
  for (const k of ["excludeSlashTmp", "excludeTmpdirEnvVar"]) {
    if (sb[k] !== undefined && typeof sb[k] !== "boolean") return "invalid_shape";
  }
  const roots = sb.writableRoots;
  if (roots !== undefined) {
    if (!Array.isArray(roots)) return "invalid_shape";
    if (roots.length > 1 || roots.some((x) => x !== cwd)) return "writable_roots";
  }
  return null;
}

export type Phase = "spawn" | "initialize" | "model_select" | "thread_start" | "turn_start" | "turn";

/** CodexErrorInfo variants (schema v0.156.0). Unknown variants map to "unrecognized". */
const CODEX_ERROR_INFO = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
  "other",
]);

/** Bounded, whitelisted failure detail. Never contains peer-supplied free text. */
export interface TaskDiagnostic {
  phase: Phase;
  rpc_code?: number | null;
  rpc_class?: RpcErrorInfo["rpc_class"];
  message_class?: RpcErrorInfo["message_class"];
  field?: string;
  /** Why the advertised default model could not be selected (src/model-select.ts). */
  model_selection?: ModelSelectionFailure;
  /** Which effective thread policy field mismatched (threadPolicyMismatch). */
  policy_mismatch?: PolicyMismatch;
  codex_error_info?: string;
  /** Which whitelisted pattern TurnError.message matched (src/turn-error.ts); not a guessed cause. */
  turn_message_class?: TurnMessageClass;
  http_status?: number;
  retried_errors?: number;
}

export interface TurnErrorSummary {
  info: string | null;
  httpStatus: number | null;
  authHint: boolean;
  messageClass: TurnMessageClass;
}

/** Reduces a TurnError to whitelisted enums; the message is only tested, never kept. */
export function summarizeTurnError(err: unknown): TurnErrorSummary {
  const e = obj(err);
  const raw = e?.codexErrorInfo;
  let info: string | null = null;
  let httpStatus: number | null = null;
  const o = obj(raw);
  if (typeof raw === "string") {
    info = CODEX_ERROR_INFO.has(raw) ? raw : "unrecognized";
  } else if (o) {
    const keys = Object.keys(o);
    const k = keys.length === 1 ? keys[0]! : "";
    info = CODEX_ERROR_INFO.has(k) ? k : "unrecognized";
    const code = obj(o[k])?.httpStatusCode;
    if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) httpStatus = code;
  }
  httpStatus ??= httpStatusFromMessage(e?.message);
  const msg = typeof e?.message === "string" ? e.message.slice(0, 2048) : "";
  return {
    info,
    httpStatus,
    authHint: /\b(unauthori[sz]ed|login required|not logged in)\b/i.test(msg),
    messageClass: classifyTurnMessage(e?.message),
  };
}

export type TaskErrorCode =
  | "APPROVAL_REQUIRED"
  | "UNSUPPORTED_SERVER_REQUEST"
  | "AUTH_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INITIALIZE_FAILED"
  | "MODEL_UNAVAILABLE"
  | "POLICY_MISMATCH"
  | "THREAD_START_FAILED"
  | "TURN_START_FAILED"
  | "TURN_FAILED"
  | "TURN_INTERRUPTED"
  | "PROTOCOL_ERROR"
  | "PROCESS_EXITED"
  | "OUTPUT_LIMIT"
  | "SPAWN_FAILED"
  | "NO_IMAGE_PRODUCED"
  | "IMAGE_ITEM_INVALID"
  | "IMAGE_VERIFICATION_FAILED"
  | "OUTPUT_ROOT_INVALID"
  | "OUTPUT_ROOT_UNAVAILABLE";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

/** Fixed, coarse request kinds. Raw request params are never inspected or returned. */
export function requestKind(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return "command_execution";
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return "file_change";
    case "item/permissions/requestApproval":
      return "permissions";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation";
    case "item/tool/requestUserInput":
      return "user_input";
    case "item/tool/call":
      return "dynamic_tool";
    case "account/chatgptAuthTokens/refresh":
      return "auth_refresh";
    default:
      return "other";
  }
}

export class TaskError extends Error {
  diagnostic: TaskDiagnostic | undefined;
  constructor(
    readonly code: TaskErrorCode,
    readonly requestKind?: string,
    diagnostic?: TaskDiagnostic,
  ) {
    super(code);
    this.name = "TaskError";
    this.diagnostic = diagnostic;
  }
}

export interface ImageItem {
  savedPath: string | null;
  status: string;
}

export interface TurnOutcome {
  text: string;
  textTruncated: boolean;
  images: ImageItem[];
  /** True when imageGeneration items beyond MAX_IMAGE_ITEMS were seen (and not kept). */
  imagesOverflow: boolean;
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  createTransport: (cwd: string) => CodexTransport;
  clientVersion: string;
  /** Internal (tests only): per-RPC deadline; never exposed to MCP callers. */
  rpcTimeoutMs?: number;
}

interface TurnDone {
  status: string;
  error: TurnErrorSummary | undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function turnErrorCode(s: TurnErrorSummary | undefined): TaskErrorCode {
  if (!s) return "TURN_FAILED";
  if (s.info === "unauthorized" || s.authHint) return "AUTH_REQUIRED";
  if (s.info === "usageLimitExceeded" || s.info === "rateLimitExceeded" || s.info === "sessionBudgetExceeded") {
    return "QUOTA_EXCEEDED";
  }
  return "TURN_FAILED";
}

const RPC_FAILURE: Record<Exclude<Phase, "spawn" | "turn">, TaskErrorCode> = {
  initialize: "INITIALIZE_FAILED",
  model_select: "MODEL_UNAVAILABLE",
  thread_start: "THREAD_START_FAILED",
  turn_start: "TURN_START_FAILED",
};

/** Maps a client error to a typed task error tagged with the lifecycle phase it happened in. */
export function fromClientError(e: unknown, phase: Phase): TaskError {
  if (e instanceof TaskError) {
    e.diagnostic ??= { phase };
    return e;
  }
  const d: TaskDiagnostic = { phase };
  if (!(e instanceof CodexClientError)) return new TaskError("PROTOCOL_ERROR", undefined, d);
  if (e.rpc) {
    d.rpc_code = e.rpc.rpc_code;
    d.rpc_class = e.rpc.rpc_class;
    d.message_class = e.rpc.message_class;
    if (e.rpc.field !== undefined) d.field = e.rpc.field;
  }
  switch (e.kind) {
    case "auth_required":
      return new TaskError("AUTH_REQUIRED", undefined, d);
    case "quota_exceeded":
      return new TaskError("QUOTA_EXCEEDED", undefined, d);
    case "timeout":
      return new TaskError("TIMEOUT", undefined, d);
    case "aborted":
      return new TaskError("CANCELLED", undefined, d);
    case "closed":
      return new TaskError("PROCESS_EXITED", undefined, d);
    case "bounds":
      return new TaskError("OUTPUT_LIMIT", undefined, d);
    case "protocol":
      return new TaskError("PROTOCOL_ERROR", undefined, d);
    default:
      return new TaskError(phase === "spawn" || phase === "turn" ? "TURN_FAILED" : RPC_FAILURE[phase], undefined, d);
  }
}

export async function runDelegatedTurn(opts: RunOptions): Promise<TurnOutcome> {
  if (opts.signal.aborted) throw new TaskError("CANCELLED", undefined, { phase: "spawn" });
  try {
    assertCwdShape(opts.cwd);
  } catch {
    // Callers pass validateCwd() output; anything else never reaches Codex.
    throw new TaskError("POLICY_MISMATCH", undefined, { phase: "spawn", policy_mismatch: "cwd" });
  }
  let transport: CodexTransport;
  try {
    transport = opts.createTransport(opts.cwd);
  } catch {
    throw new TaskError("SPAWN_FAILED", undefined, { phase: "spawn" });
  }
  const client = new CodexRpcClient(transport);

  let phase: Phase = "initialize";
  let threadId: string | undefined;
  let turnId: string | undefined;
  const completedTurns = new Map<string, TurnDone>();
  const agentTexts = new Map<string, string>();
  let textBytes = 0;
  let textTruncated = false;
  const images: ImageItem[] = [];
  let imagesOverflow = false;
  let retriedErrors = 0;
  let lastFatalError: TurnErrorSummary | undefined;

  let failWith: ((e: TaskError) => void) | undefined;
  let turnDoneResolve: ((d: TurnDone) => void) | undefined;
  let pendingFailure: TaskError | undefined;
  const fail = (e: TaskError): void => {
    if (pendingFailure) return;
    e.diagnostic ??= { phase };
    pendingFailure = e;
    failWith?.(e);
  };

  client.onServerRequest((method) => {
    const kind = requestKind(method);
    fail(new TaskError(APPROVAL_METHODS.has(method) ? "APPROVAL_REQUIRED" : "UNSUPPORTED_SERVER_REQUEST", kind));
  });

  client.onClose((kind) => fail(fromClientError(new CodexClientError(kind), phase)));

  client.onNotification((method, params) => {
    const p = obj(params);
    if (!p) return;
    if (threadId !== undefined && typeof p.threadId === "string" && p.threadId !== threadId) return;
    if (method === "item/completed") {
      const item = obj(p.item);
      if (!item) return;
      if (turnId !== undefined && typeof p.turnId === "string" && p.turnId !== turnId) return;
      if (item.type === "agentMessage" && typeof item.text === "string" && typeof item.id === "string") {
        const n = Buffer.byteLength(item.text, "utf8");
        if (textBytes + n > MAX_RESULT_TEXT_BYTES) {
          textTruncated = true;
          return;
        }
        textBytes += n;
        agentTexts.set(item.id, item.text);
      } else if (item.type === "imageGeneration") {
        if (images.length >= MAX_IMAGE_ITEMS) {
          imagesOverflow = true;
          return;
        }
        images.push({
          savedPath: typeof item.savedPath === "string" ? item.savedPath : null,
          status: typeof item.status === "string" ? item.status.slice(0, 64) : "unknown",
        });
      }
    } else if (method === "error") {
      // ErrorNotification { error: TurnError, willRetry, threadId, turnId }: only enums are kept.
      if (turnId !== undefined && typeof p.turnId === "string" && p.turnId !== turnId) return;
      if (p.willRetry === true) retriedErrors = Math.min(retriedErrors + 1, 1000);
      else lastFatalError = summarizeTurnError(p.error);
    } else if (method === "turn/completed") {
      const turn = obj(p.turn);
      if (!turn || typeof turn.id !== "string") return;
      const err = obj(turn.error);
      const done: TurnDone = {
        status: typeof turn.status === "string" ? turn.status : "unknown",
        error: err ? summarizeTurnError(err) : undefined,
      };
      // Completion may race ahead of the turn/start response: buffer by id.
      if (completedTurns.size < 16) completedTurns.set(turn.id, done);
      if (turnId === turn.id) turnDoneResolve?.(done);
    }
  });

  const failure = new Promise<never>((_, reject) => {
    failWith = reject;
  });
  failure.catch(() => undefined);
  if (pendingFailure) failWith?.(pendingFailure);

  const deadline = setTimeout(() => fail(new TaskError("TIMEOUT")), opts.timeoutMs);
  // The job deadline aborts with reason "TIMEOUT"; anything else is a cancel.
  const onAbort = (): void => fail(new TaskError(opts.signal.reason === "TIMEOUT" ? "TIMEOUT" : "CANCELLED"));
  opts.signal.addEventListener("abort", onAbort, { once: true });
  transport.onExit(() => fail(new TaskError("PROCESS_EXITED")));

  const rpc = (method: string, params: unknown): Promise<unknown> =>
    Promise.race([client.request(method, params, { timeoutMs: opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS }), failure]);

  try {
    await rpc("initialize", initializeParams(opts.clientVersion));
    client.notify("initialized");
    phase = "model_select";
    const sel = await selectDefaultModel(rpc);
    if (!sel.ok) throw new TaskError("MODEL_UNAVAILABLE", undefined, { phase, model_selection: sel.reason });
    phase = "thread_start";
    const ts = obj(await rpc("thread/start", threadStartParams(opts.cwd, sel.model)));
    const thread = obj(ts?.thread);
    if (!thread || typeof thread.id !== "string") throw new TaskError("PROTOCOL_ERROR");
    // Fail closed before any turn: the effective policy must be the bounded one.
    const mismatch = threadPolicyMismatch(ts, opts.cwd);
    if (mismatch !== null) throw new TaskError("POLICY_MISMATCH", undefined, { phase, policy_mismatch: mismatch });
    threadId = thread.id;
    phase = "turn_start";
    const turnDone = new Promise<TurnDone>((resolve) => {
      turnDoneResolve = resolve;
    });
    const tr = obj(await rpc("turn/start", turnStartParams(threadId, opts.prompt, opts.cwd)));
    const turn = obj(tr?.turn);
    if (!turn || typeof turn.id !== "string") throw new TaskError("PROTOCOL_ERROR");
    turnId = turn.id;
    phase = "turn";
    const early = completedTurns.get(turnId);
    if (early) turnDoneResolve?.(early);

    const done = await Promise.race([turnDone, failure]);
    if (pendingFailure) throw pendingFailure;
    if (done.status === "failed") {
      const s = done.error ?? lastFatalError;
      const d: TaskDiagnostic = { phase: "turn" };
      if (s?.info) d.codex_error_info = s.info;
      if (s) d.turn_message_class = s.messageClass;
      if (s?.httpStatus) d.http_status = s.httpStatus;
      if (retriedErrors > 0) d.retried_errors = retriedErrors;
      throw new TaskError(turnErrorCode(s), undefined, d);
    }
    if (done.status === "interrupted") throw new TaskError("TURN_INTERRUPTED");
    if (done.status !== "completed") throw new TaskError("PROTOCOL_ERROR");
    return { text: [...agentTexts.values()].join("\n\n"), textTruncated, images, imagesOverflow };
  } catch (e) {
    const err = pendingFailure ?? fromClientError(e, phase);
    // Best-effort interrupt of an in-flight turn, then terminate the process.
    if (threadId && turnId && !client.isClosed && err.code !== "PROCESS_EXITED") {
      try {
        await Promise.race([
          client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 2_000 }),
          new Promise((r) => setTimeout(r, 2_000)),
        ]);
      } catch {
        // Interrupt failure is irrelevant: the process is killed next.
      }
    }
    throw err;
  } finally {
    clearTimeout(deadline);
    opts.signal.removeEventListener("abort", onAbort);
    client.kill("closed");
  }
}
