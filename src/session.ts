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
//
// Image threads (RunOptions.image, src/image-sessions.ts) may instead
// thread/resume a thread this bridge itself started earlier, with the same
// explicit policy, verified identity and reapplied developer instructions,
// followed by a turn/start on that same thread id.

import { CodexClientError, CodexRpcClient, type CodexTransport, type RpcErrorInfo } from "./codex-client.js";
import { assertCwdShape } from "./cwd.js";
import { selectDefaultModel, type ModelSelectionFailure } from "./model-select.js";
import { THREAD_NAME_SET } from "./protocol-capabilities.js";
import { classifyTurnMessage, httpStatusFromMessage, type TurnMessageClass } from "./turn-error.js";
import type { ImageFile } from "./image-service.js";
import {
  APPROVAL_METHODS,
  approvalInScope,
  approvalResponse,
  fileChangesOf,
  summarizeApproval,
  type ApprovalDecision,
  type ApprovalFile,
  type ApprovalRequest,
} from "./approval-requests.js";

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
export function threadStartParams(cwd: string, model: string, developerInstructions?: string): Record<string, unknown> {
  const p: Record<string, unknown> = { cwd: assertCwdShape(cwd), model, approvalPolicy: APPROVAL_POLICY, approvalsReviewer: APPROVALS_REVIEWER, sandbox: SANDBOX_MODE };
  if (developerInstructions !== undefined) p.developerInstructions = developerInstructions;
  return p;
}

/**
 * ThreadResumeParams for a bridge-owned thread: the same explicit cwd, model,
 * approval policy, reviewer and sandbox as thread/start, the session's native
 * developer instructions reapplied, and (when the schema has it) excludeTurns
 * so no prior history is returned.
 */
export function threadResumeParams(
  threadId: string,
  cwd: string,
  model: string,
  developerInstructions: string,
  excludeTurns: boolean,
): Record<string, unknown> {
  const p: Record<string, unknown> = {
    threadId,
    cwd: assertCwdShape(cwd),
    model,
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: APPROVALS_REVIEWER,
    sandbox: SANDBOX_MODE,
    developerInstructions,
  };
  if (excludeTurns) p.excludeTurns = true;
  return p;
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
 * serde-default, sent as []), then one `localImage` UserInput per validated
 * reference image (absolute paths inside cwd, src/reference-images.ts; only
 * sent when the schema lists that variant), plus explicit cwd, approval
 * policy, reviewer and sandbox policy so nothing is inherited from config for
 * this turn.
 */
export function turnStartParams(threadId: string, prompt: string, cwd: string, referenceImages: readonly string[] = []): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }, ...referenceImages.map((p) => ({ type: "localImage", path: p }))],
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
  | "writable_roots"
  | "model";

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

/** Lifecycle phase; "saving" is the bridge's own post-turn work (copying images, version check). */
export type Phase = "spawn" | "initialize" | "model_select" | "thread_start" | "thread_name" | "thread_resume" | "turn_start" | "turn" | "saving";

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
  /** Which identity of a resumed bridge-owned thread did not match the session. */
  session_mismatch?: "thread_id" | "model";
  /** Turn-phase timeouts and failures only: native image items completed before the failure. */
  images_completed?: number;
  /** Turn-phase timeouts and failures only: ms from turn/start to the first model event (null: none arrived). */
  first_model_event_ms?: number | null;
  /** Turn-phase timeouts and failures only: ms between the last turn event and the failure (null: no event). */
  last_event_ms_ago?: number | null;
  /** Turn-phase timeouts and failures only: whitelisted enums of the last error Codex retried (e.g. a dropped connection). */
  last_retry_error_info?: string;
  last_retry_message_class?: TurnMessageClass;
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
  | "OUTPUT_ROOT_UNAVAILABLE"
  | "THREAD_RESUME_FAILED"
  | "SESSION_STALE"
  | "SESSION_INCOMPATIBLE"
  | "REFERENCE_IMAGE_INVALID";


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
  /** Verified images saved before the job failed (set by the job runner, reported as partial_files). */
  partialFiles: ImageFile[] | undefined;
  /**
   * Set by the job runner when this failure was determined before any cancel
   * or deadline: a later abort (during salvage) then does not replace it.
   */
  decided: boolean | undefined;
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
  /** Validated absolute reference image paths inside cwd, sent as localImage inputs. */
  referenceImages?: readonly string[];
  /** Receives every completed native image item of the current turn as soon as it is known. */
  onImage?: (savedPath: string) => void;
  /** Receives a getter for the live run state (progress, timing, the native thread id for salvage). */
  onState?: (get: () => TurnRunState) => void;
  /**
   * Decides approval requests of this run's thread and turn (ask / bypass
   * mode). The turn's deadline is paused while a decision is pending. Without
   * it every approval request fails the job with APPROVAL_REQUIRED (deny mode).
   */
  approvals?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Bridge-owned image thread (codex_image_generate with native instructions). */
  image?: ImageThreadOptions;
  /**
   * Strict event scoping, set for every codex_image_generate run (including the
   * prompt-wrapper fallback without `image`): only events naming both the
   * current thread and the current turn count, early ones are buffered. Task
   * runs leave it unset and keep the original lenient matching.
   */
  strictImageEvents?: boolean;
}

export interface ImageThreadOptions {
  /** Native developer instructions of the image thread (kept out of the visible user prompt). */
  developerInstructions: string;
  /** Fixed thread name, sent via thread/name/set on a new thread when the schema has it. */
  threadName: string | null;
  /** ThreadResumeParams.excludeTurns is in the schema. */
  excludeTurns: boolean;
  /** Continue this bridge-owned native thread (recorded after its own thread/start). */
  resume?: { threadId: string; model: string };
  /** Receives the verified native thread id and effective model before turn/start. */
  onThread?: (threadId: string, model: string) => void;
}

/** Live state of one run, for progress reporting and post-failure salvage (bridge-internal). */
export interface TurnRunState {
  phase: Phase;
  imagesCompleted: number;
  /** ms from turn/start to the first model event; null until one arrives. */
  firstModelEventMs: number | null;
  /** Epoch ms of the last event for this turn; null until one arrives. */
  lastEventAt: number | null;
  /** Native thread id once known. Never returned to MCP callers. */
  threadId: string | null;
  /** Epoch ms when turn/start was sent; null before. */
  turnStartedAt: number | null;
}

/** Failure codes that carry turn timing in their diagnostic. */
const TIMED_CODES = new Set<TaskErrorCode>(["TIMEOUT", "TURN_FAILED", "PROCESS_EXITED", "CANCELLED", "TURN_INTERRUPTED"]);

/** Events kept per (thread, turn) until the current turn is known. */
interface TurnAcc {
  texts: Map<string, string>;
  textBytes: number;
  textTruncated: boolean;
  images: ImageItem[];
  imagesOverflow: boolean;
  retriedErrors: number;
  lastRetried: TurnErrorSummary | undefined;
  lastFatalError: TurnErrorSummary | undefined;
}
const MAX_BUFFERED_TURNS = 8;
const newAcc = (): TurnAcc => ({
  texts: new Map(),
  textBytes: 0,
  textTruncated: false,
  images: [],
  imagesOverflow: false,
  retriedErrors: 0,
  lastRetried: undefined,
  lastFatalError: undefined,
});
const turnKey = (threadId: string, turnId: string): string => `${threadId}\n${turnId}`;

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

const RPC_FAILURE: Record<Exclude<Phase, "spawn" | "turn" | "saving">, TaskErrorCode> = {
  initialize: "INITIALIZE_FAILED",
  model_select: "MODEL_UNAVAILABLE",
  thread_start: "THREAD_START_FAILED",
  thread_name: "THREAD_START_FAILED",
  thread_resume: "THREAD_RESUME_FAILED",
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
      return new TaskError(phase === "spawn" || phase === "turn" || phase === "saving" ? "TURN_FAILED" : RPC_FAILURE[phase], undefined, d);
  }
}

/**
 * Whether a turn notification shows model activity: an item event or delta
 * (item/*) other than the echoed user message. Turn bookkeeping, retries,
 * warnings (e.g. a transport fallback), thread and account updates do not
 * count. Used only for the first-model-event latency.
 */
function isModelEvent(method: string, item: Record<string, unknown> | undefined): boolean {
  return method.startsWith("item/") && item?.type !== "userMessage";
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
  // Image jobs are strict: an event counts only if it names both the
  // current thread and the current turn. Events that arrive before the
  // turn/start response are buffered per (thread, turn) and anything for a
  // prior or unnamed turn is discarded; a resumed thread's history is never
  // read. Task threads keep the original lenient matching.
  const strict = opts.strictImageEvents === true;
  const legacy = newAcc();
  const buffered = new Map<string, TurnAcc>();
  let bufferOverflow = false;

  // Live state for progress reporting and post-failure salvage (onState getter).
  let turnStartedAt: number | null = null;
  let firstModelEventMs: number | null = null;
  let lastEventAt: number | null = null;
  /** The current turn's accumulator: the lenient one for tasks, the (thread, turn) buffer once known for images. */
  const currentAcc = (): TurnAcc | undefined =>
    !strict ? legacy : threadId !== undefined && turnId !== undefined ? buffered.get(turnKey(threadId, turnId)) : undefined;
  const completedImages = (): number => currentAcc()?.images.filter((i) => i.savedPath !== null && i.status === "completed").length ?? 0;
  // Each completed native image item of the current turn goes to opts.onImage once, in arrival order.
  let delivered = 0;
  const deliver = (): void => {
    const acc = currentAcc();
    if (!acc) return;
    for (; delivered < acc.images.length; delivered++) {
      const i = acc.images[delivered]!;
      if (i.savedPath === null || i.status !== "completed") continue;
      try {
        opts.onImage?.(i.savedPath);
      } catch {
        // Saving is the caller's concern; the turn continues.
      }
    }
  };
  opts.onState?.(() => ({
    phase,
    imagesCompleted: completedImages(),
    firstModelEventMs,
    lastEventAt,
    threadId: threadId ?? null,
    turnStartedAt,
  }));

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

  // Files announced by fileChange items, so a file-change approval can name them (bounded).
  const fileChanges = new Map<string, { files: ApprovalFile[]; truncated: boolean }>();
  const decide = opts.approvals;
  if (decide) {
    client.answerServerRequests(APPROVAL_METHODS, async (method, params) => {
      // Only requests of this run's own thread and turn; anything else is denied.
      if (pendingFailure || !approvalInScope(method, params, threadId, turnId)) return null;
      const request = summarizeApproval(method, params, (id) => fileChanges.get(id));
      if (!request) return null;
      pauseDeadline();
      try {
        return { result: approvalResponse(method, params, await decide(request)) };
      } finally {
        resumeDeadline();
      }
    });
  }

  client.onClose((kind) => fail(fromClientError(new CodexClientError(kind), phase)));

  /** Target accumulator of a turn-scoped event, or undefined when it must be ignored. */
  const accFor = (p: Record<string, unknown>): TurnAcc | undefined => {
    if (!strict) {
      if (turnId !== undefined && typeof p.turnId === "string" && p.turnId !== turnId) return undefined;
      return legacy;
    }
    if (typeof p.threadId !== "string" || typeof p.turnId !== "string") return undefined;
    if ((threadId !== undefined && p.threadId !== threadId) || (turnId !== undefined && p.turnId !== turnId)) return undefined;
    const key = turnKey(p.threadId, p.turnId);
    let acc = buffered.get(key);
    if (!acc) {
      if (buffered.size >= MAX_BUFFERED_TURNS) {
        bufferOverflow = true;
        return undefined;
      }
      acc = newAcc();
      buffered.set(key, acc);
    }
    return acc;
  };

  client.onNotification((method, params) => {
    const p = obj(params);
    if (!p) return;
    if (threadId !== undefined && typeof p.threadId === "string" && p.threadId !== threadId) return;
    if (turnStartedAt !== null && (turnId === undefined || typeof p.turnId !== "string" || p.turnId === turnId)) {
      const now = Date.now();
      lastEventAt = now;
      if (firstModelEventMs === null && isModelEvent(method, obj(p.item))) firstModelEventMs = now - turnStartedAt;
    }
    if ((method === "item/started" || method === "item/updated") && obj(p.item)?.type === "fileChange") {
      const item = obj(p.item)!;
      if (typeof item.id === "string" && (fileChanges.size < 64 || fileChanges.has(item.id))) fileChanges.set(item.id, fileChangesOf(item));
    }
    if (method === "item/completed") {
      const item = obj(p.item);
      if (!item) return;
      const acc = accFor(p);
      if (!acc) return;
      if (item.type === "agentMessage" && typeof item.text === "string" && typeof item.id === "string") {
        const n = Buffer.byteLength(item.text, "utf8");
        if (acc.textBytes + n > MAX_RESULT_TEXT_BYTES) {
          acc.textTruncated = true;
          return;
        }
        acc.textBytes += n;
        acc.texts.set(item.id, item.text);
      } else if (item.type === "imageGeneration") {
        if (acc.images.length >= MAX_IMAGE_ITEMS) {
          acc.imagesOverflow = true;
          return;
        }
        acc.images.push({
          savedPath: typeof item.savedPath === "string" ? item.savedPath : null,
          status: typeof item.status === "string" ? item.status.slice(0, 64) : "unknown",
        });
        deliver();
      }
    } else if (method === "error") {
      // ErrorNotification { error: TurnError, willRetry, threadId, turnId }: only enums are kept.
      const acc = accFor(p);
      if (!acc) return;
      if (p.willRetry === true) {
        acc.retriedErrors = Math.min(acc.retriedErrors + 1, 1000);
        acc.lastRetried = summarizeTurnError(p.error);
      } else acc.lastFatalError = summarizeTurnError(p.error);
    } else if (method === "turn/completed") {
      const turn = obj(p.turn);
      if (!turn || typeof turn.id !== "string") return;
      if (strict && typeof p.threadId !== "string") return;
      const err = obj(turn.error);
      const done: TurnDone = {
        status: typeof turn.status === "string" ? turn.status : "unknown",
        error: err ? summarizeTurnError(err) : undefined,
      };
      // Completion may race ahead of the turn/start response: buffer by id
      // (by thread and id for image threads).
      const key = strict ? turnKey(p.threadId as string, turn.id) : turn.id;
      if (completedTurns.size < 16) completedTurns.set(key, done);
      if (turnId === turn.id && (!strict || p.threadId === threadId)) turnDoneResolve?.(done);
    }
  });

  const failure = new Promise<never>((_, reject) => {
    failWith = reject;
  });
  failure.catch(() => undefined);
  if (pendingFailure) failWith?.(pendingFailure);

  // The turn's own deadline; paused while an approval decision is pending.
  let deadlineLeft = opts.timeoutMs;
  let deadlineSince = Date.now();
  let paused = 0;
  const onDeadline = (): void => fail(new TaskError("TIMEOUT"));
  let deadline: NodeJS.Timeout | undefined = setTimeout(onDeadline, opts.timeoutMs);
  function pauseDeadline(): void {
    if (paused++ > 0 || deadline === undefined) return;
    clearTimeout(deadline);
    deadline = undefined;
    deadlineLeft -= Date.now() - deadlineSince;
  }
  function resumeDeadline(): void {
    if (--paused > 0 || pendingFailure) return;
    deadlineSince = Date.now();
    deadline = setTimeout(onDeadline, Math.max(0, deadlineLeft));
  }
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
    const image = opts.image;
    if (image?.resume) {
      // Continuation of a bridge-owned thread: the advertised default must
      // still be the session's model, and the resumed thread must report the
      // same id, model and bounded policy before any turn.
      const resume = image.resume;
      if (sel.model !== resume.model) throw new TaskError("SESSION_INCOMPATIBLE", undefined, { phase, session_mismatch: "model" });
      phase = "thread_resume";
      threadId = resume.threadId;
      let rs: Record<string, unknown> | undefined;
      try {
        rs = obj(await rpc("thread/resume", threadResumeParams(resume.threadId, opts.cwd, resume.model, image.developerInstructions, image.excludeTurns)));
      } catch (e) {
        const cls = e instanceof CodexClientError ? e.rpc?.message_class : undefined;
        if (cls === "thread_not_found" || cls === "invalid_thread_id") {
          const t = fromClientError(e, phase);
          throw new TaskError("SESSION_STALE", undefined, t.diagnostic);
        }
        throw e;
      }
      const thread = obj(rs?.thread);
      if (!thread || typeof thread.id !== "string") throw new TaskError("PROTOCOL_ERROR");
      if (thread.id !== resume.threadId) throw new TaskError("SESSION_STALE", undefined, { phase, session_mismatch: "thread_id" });
      const mismatch = threadPolicyMismatch(rs, opts.cwd);
      if (mismatch !== null) throw new TaskError("POLICY_MISMATCH", undefined, { phase, policy_mismatch: mismatch });
      if (rs?.model !== resume.model) throw new TaskError("SESSION_INCOMPATIBLE", undefined, { phase, session_mismatch: "model" });
    } else {
      phase = "thread_start";
      const ts = obj(await rpc("thread/start", threadStartParams(opts.cwd, sel.model, image?.developerInstructions)));
      const thread = obj(ts?.thread);
      if (!thread || typeof thread.id !== "string") throw new TaskError("PROTOCOL_ERROR");
      // Fail closed before any turn: the effective policy must be the bounded one.
      const mismatch = threadPolicyMismatch(ts, opts.cwd);
      if (mismatch !== null) throw new TaskError("POLICY_MISMATCH", undefined, { phase, policy_mismatch: mismatch });
      // An image thread may later be resumed with this model: it must be the one requested.
      if (image && ts?.model !== sel.model) throw new TaskError("POLICY_MISMATCH", undefined, { phase, policy_mismatch: "model" });
      threadId = thread.id;
      if (image?.threadName) {
        phase = "thread_name";
        try {
          await rpc(THREAD_NAME_SET, { threadId, name: image.threadName });
        } catch (e) {
          // Only a peer that does not implement the optional method is skipped;
          // transport, policy and other errors fail the job.
          if (!(e instanceof CodexClientError && e.kind === "server_error" && e.rpc?.rpc_class === "method_not_found")) throw e;
        }
      }
    }
    image?.onThread?.(threadId, sel.model);
    phase = "turn_start";
    const turnDone = new Promise<TurnDone>((resolve) => {
      turnDoneResolve = resolve;
    });
    turnStartedAt = Date.now();
    const tr = obj(await rpc("turn/start", turnStartParams(threadId, opts.prompt, opts.cwd, opts.referenceImages ?? [])));
    const turn = obj(tr?.turn);
    if (!turn || typeof turn.id !== "string") throw new TaskError("PROTOCOL_ERROR");
    turnId = turn.id;
    deliver();
    phase = "turn";
    const early = completedTurns.get(strict ? turnKey(threadId, turnId) : turnId);
    if (early) turnDoneResolve?.(early);

    const done = await Promise.race([turnDone, failure]);
    if (pendingFailure) throw pendingFailure;
    // Strict: only the current (thread, turn) buffer; a dropped buffer may have been ours.
    if (strict && bufferOverflow && !buffered.has(turnKey(threadId, turnId))) throw new TaskError("OUTPUT_LIMIT");
    const acc = strict ? (buffered.get(turnKey(threadId, turnId)) ?? newAcc()) : legacy;
    if (done.status === "failed") {
      const s = done.error ?? acc.lastFatalError;
      const d: TaskDiagnostic = { phase: "turn" };
      if (s?.info) d.codex_error_info = s.info;
      if (s) d.turn_message_class = s.messageClass;
      if (s?.httpStatus) d.http_status = s.httpStatus;
      if (acc.retriedErrors > 0) d.retried_errors = acc.retriedErrors;
      throw new TaskError(turnErrorCode(s), undefined, d);
    }
    if (done.status === "interrupted") throw new TaskError("TURN_INTERRUPTED");
    if (done.status !== "completed") throw new TaskError("PROTOCOL_ERROR");
    return { text: [...acc.texts.values()].join("\n\n"), textTruncated: acc.textTruncated, images: acc.images, imagesOverflow: acc.imagesOverflow };
  } catch (e) {
    const err = pendingFailure ?? fromClientError(e, phase);
    if (err.diagnostic?.phase === "turn" && TIMED_CODES.has(err.code)) {
      const d = err.diagnostic;
      const n = completedImages();
      if (n > 0) d.images_completed = n;
      d.first_model_event_ms = firstModelEventMs;
      d.last_event_ms_ago = lastEventAt === null ? null : Date.now() - lastEventAt;
      // A turn that times out while Codex keeps reconnecting is a network problem, not a slow model.
      const acc = currentAcc();
      if (acc && acc.retriedErrors > 0) d.retried_errors ??= acc.retriedErrors;
      if (acc?.lastRetried?.info) d.last_retry_error_info = acc.lastRetried.info;
      if (acc?.lastRetried) d.last_retry_message_class = acc.lastRetried.messageClass;
    }
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
