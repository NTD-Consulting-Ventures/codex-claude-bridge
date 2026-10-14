// Bounded, in-memory image sessions (one store per ToolHandler / MCP process).
//
// A session maps a bridge-generated opaque random handle to the native Codex
// thread this bridge itself started for an image. The native thread id is
// never returned to callers, and callers can never name an arbitrary thread:
// only handles issued by this store are accepted. Nothing is persisted, so a
// restart invalidates every handle; existing native user threads are never
// enumerated or resumed.
//
// Limits: at most MAX_SESSIONS retained (least recently used evicted), idle
// TTL, MAX_TURNS successful turns and MAX_PROMPT_CHARS cumulative user prompt
// characters per session. Hitting a turn/prompt limit is a recoverable
// rollover error: the caller must explicitly start a fresh session; nothing is
// generated or retried automatically.

import { randomBytes } from "node:crypto";

export const SESSION_LIMITS = Object.freeze({
  maxSessions: 8,
  idleTtlMs: 30 * 60_000,
  maxTurns: 8,
  maxPromptChars: 128_000,
});
const MAX_TOMBSTONES = 64;

/** `cis_` + 24 random bytes base64url. */
export const SESSION_HANDLE_PATTERN = "^cis_[A-Za-z0-9_-]{32}$";
const HANDLE_RE = new RegExp(SESSION_HANDLE_PATTERN);

export function isSessionHandleShape(v: unknown): v is string {
  return typeof v === "string" && HANDLE_RE.test(v);
}

/** Everything a continuation must share with the turn that created the session. */
export interface SessionContext {
  cwd: string;
  mode: string;
  outputRoot: string;
  launcher: string;
  policy: string;
}
const CONTEXT_KEYS = ["cwd", "mode", "outputRoot", "launcher", "policy"] as const;
export type ContextMismatch = (typeof CONTEXT_KEYS)[number];

export type RevokeReason = "expired" | "evicted" | "invalidated" | "reset";

export type SessionRejectCode = "SESSION_UNKNOWN" | "SESSION_EXPIRED" | "SESSION_INVALIDATED" | "SESSION_ROLLOVER_REQUIRED" | "SESSION_INCOMPATIBLE";

export interface SessionReject {
  code: SessionRejectCode;
  /** Fixed enum detail: revoke reason, exhausted limit or mismatching context field. */
  detail: RevokeReason | "max_turns" | "max_prompt_chars" | ContextMismatch | null;
}

export interface ImageSession {
  readonly handle: string;
  readonly ctx: SessionContext;
  /** Native thread id; bridge-internal, set only after a verified successful first turn. */
  threadId: string | null;
  /** Effective model of the native thread. */
  model: string | null;
  turns: number;
  promptChars: number;
  lastUsedAt: number;
  lastJobId: string | null;
  inUse: boolean;
}

/** Caller-facing session metadata (never contains the native thread id). */
export interface SessionView {
  continuity: "available";
  turns_used: number;
  max_turns: number;
  prompt_chars_used: number;
  max_prompt_chars: number;
  idle_ttl_seconds: number;
  expires_at: string;
  previous_job_id: string | null;
  continued: boolean;
}

export class ImageSessionStore {
  private readonly sessions = new Map<string, ImageSession>();
  private readonly tombstones = new Map<string, RevokeReason>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    this.prune();
    return this.sessions.size;
  }

  /** Drops idle-expired sessions (in-use ones never expire). */
  private prune(): void {
    const t = this.now();
    for (const s of this.sessions.values()) {
      if (!s.inUse && t - s.lastUsedAt > SESSION_LIMITS.idleTtlMs) this.revoke(s.handle, "expired");
    }
  }

  /** Whether this handle was ever issued by this store (live or revoked). */
  owns(handle: string): boolean {
    return this.sessions.has(handle) || this.tombstones.has(handle);
  }

  revoke(handle: string, reason: RevokeReason): void {
    if (!this.sessions.delete(handle)) return;
    this.tombstones.delete(handle);
    this.tombstones.set(handle, reason);
    while (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value!);
  }

  /** Validates a continuation without changing any state. */
  check(handle: string, ctx: SessionContext, promptChars: number): ImageSession | SessionReject {
    this.prune();
    const s = this.sessions.get(handle);
    if (!s) {
      const r = this.tombstones.get(handle);
      if (r === undefined) return { code: "SESSION_UNKNOWN", detail: null };
      return { code: r === "expired" || r === "evicted" ? "SESSION_EXPIRED" : "SESSION_INVALIDATED", detail: r };
    }
    // A session is only continuable after a verified successful first turn.
    if (s.inUse || s.threadId === null || s.model === null) return { code: "SESSION_INVALIDATED", detail: "invalidated" };
    for (const k of CONTEXT_KEYS) if (s.ctx[k] !== ctx[k]) return { code: "SESSION_INCOMPATIBLE", detail: k };
    if (s.turns >= SESSION_LIMITS.maxTurns) return { code: "SESSION_ROLLOVER_REQUIRED", detail: "max_turns" };
    if (s.promptChars + promptChars > SESSION_LIMITS.maxPromptChars) return { code: "SESSION_ROLLOVER_REQUIRED", detail: "max_prompt_chars" };
    return s;
  }

  /** Reserves a new session for a first turn; evicts the least recently used idle session at the cap. */
  create(ctx: SessionContext): ImageSession {
    this.prune();
    while (this.sessions.size >= SESSION_LIMITS.maxSessions) {
      const lru = [...this.sessions.values()].filter((s) => !s.inUse).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!lru) break;
      this.revoke(lru.handle, "evicted");
    }
    const s: ImageSession = {
      handle: `cis_${randomBytes(24).toString("base64url")}`,
      ctx: { ...ctx },
      threadId: null,
      model: null,
      turns: 0,
      promptChars: 0,
      lastUsedAt: this.now(),
      lastJobId: null,
      inUse: false,
    };
    this.sessions.set(s.handle, s);
    return s;
  }

  lease(s: ImageSession): void {
    s.inUse = true;
    s.lastUsedAt = this.now();
  }

  /** Releases a lease without consuming a turn (the job never started). */
  release(s: ImageSession): void {
    s.inUse = false;
    if (s.threadId === null) this.sessions.delete(s.handle);
  }

  /** Records a successful turn on the verified native thread. */
  succeed(s: ImageSession, threadId: string, model: string, promptChars: number, jobId: string): void {
    if (this.sessions.get(s.handle) !== s || (s.threadId !== null && s.threadId !== threadId)) {
      this.revoke(s.handle, "invalidated");
      return;
    }
    s.threadId = threadId;
    s.model = model;
    s.turns++;
    s.promptChars += promptChars;
    s.lastJobId = jobId;
    s.lastUsedAt = this.now();
    s.inUse = false;
  }

  /** Any non-success (cancel, timeout, error, post-processing failure) revokes the handle. */
  fail(s: ImageSession): void {
    s.inUse = false;
    this.revoke(s.handle, "invalidated");
  }

  /** Metadata as it will be after the pending turn (when `pending`) succeeds. */
  view(s: ImageSession, pending: { promptChars: number; jobId: string } | null, continued: boolean): SessionView {
    const turns = s.turns + (pending ? 1 : 0);
    const chars = s.promptChars + (pending?.promptChars ?? 0);
    return {
      continuity: "available",
      turns_used: turns,
      max_turns: SESSION_LIMITS.maxTurns,
      prompt_chars_used: chars,
      max_prompt_chars: SESSION_LIMITS.maxPromptChars,
      idle_ttl_seconds: SESSION_LIMITS.idleTtlMs / 1000,
      expires_at: new Date(this.now() + SESSION_LIMITS.idleTtlMs).toISOString(),
      previous_job_id: continued ? s.lastJobId : null,
      continued,
    };
  }

  /** Current usability of a handle, for job polling. */
  state(handle: string): { usable: boolean; reason: RevokeReason | null } {
    this.prune();
    const s = this.sessions.get(handle);
    if (s) return { usable: s.threadId !== null && !s.inUse, reason: null };
    return { usable: false, reason: this.tombstones.get(handle) ?? "invalidated" };
  }
}
