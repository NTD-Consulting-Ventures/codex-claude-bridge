// Bounded newline-delimited JSON-RPC client for the Codex app-server protocol.
//
// Transport-agnostic: the live transport is src/process-transport.ts, tests
// inject fixture transports.

export interface CodexTransport {
  /** Write one already-framed line (including trailing "\n"). */
  write(data: string): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: () => void): void;
  /** Forcefully terminate the peer. Must be idempotent. */
  kill(): void;
  /** Gracefully close the peer. Must be idempotent. */
  close(): void;
}

export interface CodexClientLimits {
  maxFrameBytes: number;
  maxTotalStdoutBytes: number;
  maxStderrBytes: number;
  maxPendingRequests: number;
  defaultTimeoutMs: number;
}

// A completed native imageGeneration item carries the image inline (schema
// field `result`, base64), so one frame can exceed the encoded image size
// (~1.33x the PNG). 8 MiB per frame and 64 MiB per process stay bounded.
export const DEFAULT_LIMITS: CodexClientLimits = {
  maxFrameBytes: 8 * 1024 * 1024,
  maxTotalStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  maxPendingRequests: 16,
  defaultTimeoutMs: 30_000,
};

export type CodexErrorKind =
  | "auth_required"
  | "quota_exceeded"
  | "timeout"
  | "aborted"
  | "closed"
  | "protocol"
  | "bounds"
  | "server_error";

const SAFE_MESSAGES: Record<CodexErrorKind, string> = {
  auth_required: "Codex reported that authentication is required.",
  quota_exceeded: "Codex reported a usage limit or quota error.",
  timeout: "Codex request timed out.",
  aborted: "Codex request was aborted.",
  closed: "Codex connection is closed.",
  protocol: "Codex sent an invalid protocol message.",
  bounds: "Codex output exceeded configured bounds.",
  server_error: "Codex returned an error.",
};

/** JSON-RPC error code family. Derived from the numeric code only. */
export type RpcErrorClass =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "internal_error"
  | "server_defined"
  | "unauthorized"
  | "rate_limited"
  | "other";

/**
 * Whitelisted shapes of known app-server failure messages (codex-cli 0.156.0
 * `message_processor.rs` / serde). Anything else is "unrecognized"; the raw
 * message is never kept because it can embed ids, paths or prompt text.
 */
export type RpcMessageClass =
  | "not_initialized"
  | "already_initialized"
  | "experimental_api_required"
  | "missing_field"
  | "unknown_field"
  | "unknown_variant"
  | "invalid_type"
  | "invalid_value"
  | "invalid_thread_id"
  | "thread_not_found"
  | "error_creating_thread"
  | "server_shutting_down"
  | "unrecognized"
  | "absent";

/** Safe, bounded description of a JSON-RPC error object. */
export interface RpcErrorInfo {
  rpc_code: number | null;
  rpc_class: RpcErrorClass;
  message_class: RpcMessageClass;
  /** Schema identifier named by a serde error (e.g. a missing field), if it is a plain identifier. */
  field?: string;
}

/** Error with a fixed, sanitized message. Raw peer text is never included. */
export class CodexClientError extends Error {
  readonly kind: CodexErrorKind;
  readonly rpcCode: number | undefined;
  readonly rpc: RpcErrorInfo | undefined;
  constructor(kind: CodexErrorKind, rpc?: RpcErrorInfo) {
    super(SAFE_MESSAGES[kind]);
    this.name = "CodexClientError";
    this.kind = kind;
    this.rpc = rpc;
    this.rpcCode = rpc?.rpc_code ?? undefined;
  }
}

function rpcClass(code: unknown): RpcErrorClass {
  if (typeof code !== "number" || !Number.isInteger(code)) return "other";
  switch (code) {
    case -32700:
      return "parse_error";
    case -32600:
      return "invalid_request";
    case -32601:
      return "method_not_found";
    case -32602:
      return "invalid_params";
    case -32603:
      return "internal_error";
    case 401:
      return "unauthorized";
    case 429:
      return "rate_limited";
    default:
      return code >= -32099 && code <= -32000 ? "server_defined" : "other";
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function messageClass(message: unknown, data: unknown): { cls: RpcMessageClass; field?: string } {
  if (obj(data)?.reason === "serverShuttingDown") return { cls: "server_shutting_down" };
  if (typeof message !== "string") return { cls: "absent" };
  const m = message.slice(0, 2048);
  if (/^Not initialized$/.test(m)) return { cls: "not_initialized" };
  if (/^Already initialized/i.test(m)) return { cls: "already_initialized" };
  if (/experimental/i.test(m) && /\b(api|capability|requires?|required)\b/i.test(m)) return { cls: "experimental_api_required" };
  const serde: [RegExp, RpcMessageClass][] = [
    [/missing field `([^`]{1,64})`/, "missing_field"],
    [/unknown field `([^`]{1,64})`/, "unknown_field"],
    [/unknown variant `([^`]{1,64})`/, "unknown_variant"],
  ];
  for (const [re, cls] of serde) {
    const f = re.exec(m)?.[1];
    if (f !== undefined) return IDENT.test(f) ? { cls, field: f } : { cls };
  }
  if (/\binvalid type: /.test(m)) return { cls: "invalid_type" };
  if (/\binvalid value: /.test(m)) return { cls: "invalid_value" };
  if (/^invalid thread id/i.test(m)) return { cls: "invalid_thread_id" };
  if (/^thread not found/i.test(m)) return { cls: "thread_not_found" };
  if (/^error creating thread/i.test(m)) return { cls: "error_creating_thread" };
  return { cls: "unrecognized" };
}

/** Maps a raw JSON-RPC error object to whitelisted enums. Never returns peer text. */
export function describeRpcError(err: unknown): RpcErrorInfo {
  const e = obj(err) ?? {};
  const code = typeof e.code === "number" && Number.isInteger(e.code) ? e.code : null;
  const { cls, field } = messageClass(e.message, e.data);
  const info: RpcErrorInfo = { rpc_code: code, rpc_class: rpcClass(code), message_class: cls };
  if (field !== undefined) info.field = field;
  return info;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** JSON-RPC error code returned for every server-initiated request. */
export const DENIED_CODE = -32001;
const DENIED_MESSAGE = "Request denied by codex-image-mcp: server-initiated requests are not permitted.";

export function classifyRpcError(err: unknown): CodexErrorKind {
  if (typeof err !== "object" || err === null) return "server_error";
  const e = err as { code?: unknown; message?: unknown; data?: unknown };
  const text = [e.message, safeStringify(e.data)]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .slice(0, 4096)
    .toLowerCase();
  if (e.code === 401 || /\b(unauthori[sz]ed|not logged in|login required|authentication|auth required)\b/.test(text)) {
    return "auth_required";
  }
  if (e.code === 429 || /\b(quota|rate.?limit|usage limit|too many requests|insufficient_quota)\b/.test(text)) {
    return "quota_exceeded";
  }
  return "server_error";
}

function safeStringify(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/** Splits a byte stream into newline-terminated frames with a per-frame cap. */
export class LineFramer {
  private buf = "";
  private bufBytes = 0;
  constructor(private readonly maxFrameBytes: number) {}

  /** Returns complete lines; throws CodexClientError("bounds") on oversize. */
  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl === -1) break;
      const piece = chunk.slice(start, nl);
      const pieceBytes = Buffer.byteLength(piece, "utf8");
      if (this.bufBytes + pieceBytes > this.maxFrameBytes) throw new CodexClientError("bounds");
      let line = this.buf + piece;
      this.buf = "";
      this.bufBytes = 0;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) out.push(line);
      start = nl + 1;
    }
    const rest = chunk.slice(start);
    if (rest.length > 0) {
      const restBytes = Buffer.byteLength(rest, "utf8");
      if (this.bufBytes + restBytes > this.maxFrameBytes) throw new CodexClientError("bounds");
      this.buf += rest;
      this.bufBytes += restBytes;
    }
    return out;
  }

  get hasPartial(): boolean {
    return this.bufBytes > 0;
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: CodexClientError) => void;
  timer: NodeJS.Timeout;
  cleanupAbort: () => void;
}

type Id = number | string;

export class CodexRpcClient {
  private readonly limits: CodexClientLimits;
  private readonly framer: LineFramer;
  private readonly pending = new Map<Id, Pending>();
  private nextId = 1;
  private totalStdout = 0;
  private stderrBytes = 0;
  private closed = false;
  private notificationHandler: NotificationHandler | undefined;
  private serverRequestObserver: ((method: string) => void) | undefined;
  private closeObserver: ((kind: CodexErrorKind) => void) | undefined;

  /** Diagnostic counters only; contain no peer content. */
  readonly stats = { lateResponses: 0, deniedServerRequests: 0, droppedStderrBytes: 0, invalidFrames: 0 };

  constructor(
    private readonly transport: CodexTransport,
    limits: Partial<CodexClientLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.framer = new LineFramer(this.limits.maxFrameBytes);
    transport.onStdout((c) => this.handleStdout(c));
    transport.onStderr((c) => this.handleStderr(c));
    transport.onExit(() => this.shutdown("closed", false));
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Called (after the denial is written) with the method of each server-initiated request. */
  onServerRequest(observer: (method: string) => void): void {
    this.serverRequestObserver = observer;
  }

  /** Called once when the client closes, with the reason (bounds, protocol, closed, ...). */
  onClose(observer: (kind: CodexErrorKind) => void): void {
    this.closeObserver = observer;
  }

  /** Sends a client notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    if (this.closed) throw new CodexClientError("closed");
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.writeSafe(msg);
  }

  /** Forcefully terminates the peer and rejects pending requests. */
  kill(kind: CodexErrorKind = "aborted"): void {
    this.shutdown(kind, true);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Sends a single request. Never retries. */
  request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexClientError("closed"));
    if (opts.signal?.aborted) return Promise.reject(new CodexClientError("aborted"));
    if (this.pending.size >= this.limits.maxPendingRequests) {
      return Promise.reject(new CodexClientError("bounds"));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    const line = JSON.stringify(msg) + "\n";
    if (Buffer.byteLength(line, "utf8") > this.limits.maxFrameBytes) {
      return Promise.reject(new CodexClientError("bounds"));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.limits.defaultTimeoutMs;
      const timer = setTimeout(() => {
        // A request that times out leaves the peer in an unknown state: fail
        // closed, reporting "timeout" (not "closed") as the close reason so
        // observers keep the root cause.
        this.settle(id, new CodexClientError("timeout"));
        this.shutdown("timeout", true);
      }, timeoutMs);
      let cleanupAbort = (): void => {};
      if (opts.signal) {
        const signal = opts.signal;
        const onAbort = (): void => {
          this.settle(id, new CodexClientError("aborted"));
          this.shutdown("aborted", true);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, { resolve, reject, timer, cleanupAbort });
      try {
        this.transport.write(line);
      } catch {
        this.settle(id, new CodexClientError("closed"));
        this.shutdown("closed", true);
      }
    });
  }

  /** Graceful close: rejects all pending requests and closes the transport. */
  close(): void {
    this.shutdown("closed", false);
  }

  private settle(id: Id, result: CodexClientError | { value: unknown }): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.cleanupAbort();
    if (result instanceof CodexClientError) p.reject(result);
    else p.resolve(result.value);
    return true;
  }

  private shutdown(kind: CodexErrorKind, kill: boolean): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.settle(id, new CodexClientError(kind));
    try {
      this.closeObserver?.(kind);
    } catch {
      // Observer faults are not actionable.
    }
    try {
      if (kill) this.transport.kill();
      else this.transport.close();
    } catch {
      // Transport teardown errors are not actionable and must not leak.
    }
  }

  private handleStderr(chunk: string): void {
    // Stderr is counted, never parsed, stored or surfaced. Beyond the cap it
    // is only counted as dropped: stderr is diagnostic noise, not protocol,
    // so it does not fail the job.
    const n = Buffer.byteLength(chunk, "utf8");
    if (this.stderrBytes + n > this.limits.maxStderrBytes) this.stats.droppedStderrBytes += n;
    else this.stderrBytes += n;
  }

  private handleStdout(chunk: string): void {
    if (this.closed) return;
    this.totalStdout += Buffer.byteLength(chunk, "utf8");
    if (this.totalStdout > this.limits.maxTotalStdoutBytes) {
      this.failClosed("bounds");
      return;
    }
    let lines: string[];
    try {
      lines = this.framer.push(chunk);
    } catch {
      this.failClosed("bounds");
      return;
    }
    for (const line of lines) {
      if (this.closed) return;
      this.handleLine(line);
    }
  }

  private failClosed(kind: CodexErrorKind): void {
    if (this.closed) return;
    for (const id of [...this.pending.keys()]) this.settle(id, new CodexClientError(kind));
    this.shutdown(kind, true);
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.stats.invalidFrames++;
      this.failClosed("protocol");
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.stats.invalidFrames++;
      this.failClosed("protocol");
      return;
    }
    const m = msg as Record<string, unknown>;
    const hasId = typeof m.id === "number" || typeof m.id === "string";
    const hasMethod = typeof m.method === "string";

    if (hasMethod && hasId) {
      // Server-initiated request (approvals, elicitation, auth refresh, dynamic tools).
      // Always denied with an error; no result is ever fabricated. The observer
      // only learns the method name so the caller can fail the job.
      this.stats.deniedServerRequests++;
      this.writeSafe({ jsonrpc: "2.0", id: m.id, error: { code: DENIED_CODE, message: DENIED_MESSAGE } });
      try {
        this.serverRequestObserver?.(m.method as string);
      } catch {
        // Observer faults must not break framing.
      }
      return;
    }
    if (hasMethod) {
      try {
        this.notificationHandler?.(m.method as string, m.params);
      } catch {
        // Handler faults must not break framing.
      }
      return;
    }
    if (hasId && ("result" in m || "error" in m)) {
      const id = m.id as Id;
      if (!this.pending.has(id)) {
        this.stats.lateResponses++;
        return;
      }
      if ("error" in m && m.error !== undefined && m.error !== null) {
        this.settle(id, new CodexClientError(classifyRpcError(m.error), describeRpcError(m.error)));
      } else {
        this.settle(id, { value: m.result });
      }
      return;
    }
    this.stats.invalidFrames++;
    this.failClosed("protocol");
  }

  private writeSafe(obj: unknown): void {
    try {
      this.transport.write(JSON.stringify(obj) + "\n");
    } catch {
      this.failClosed("closed");
    }
  }
}
