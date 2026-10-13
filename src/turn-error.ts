// Deterministic, bounded classification of a TurnError.message into a fixed
// enum. The message is only TESTED against whitelisted patterns; it is never
// stored in or returned from a task error. A class says what the message text
// literally matched, not a guessed root cause.
//
// Source provenance (codex-cli rust-v0.156.0, partial local checkout):
// - "hook_aborted": core/src/hook_runtime.rs:653-664 emits
//   "after_agent hook '<name>' failed and aborted turn completion: <error>"
//   with CodexErrorInfo::Other. Verified against fetched source.
// - Every other class is a generic pattern. core/src/error.rs (CodexErr ->
//   CodexErrorInfo mapping) was NOT fetched, so those message shapes are
//   unverified against source.

export type TurnMessageClass =
  | "hook_aborted"
  | "attestation"
  | "auth"
  | "unsupported_parameter"
  | "provider"
  | "model"
  | "network"
  | "server_error"
  | "unrecognized"
  | "absent";

export const MAX_SCANNED_MESSAGE_CHARS = 2048;

// Order matters: first match wins. All patterns are bounded and backtracking-safe.
const PATTERNS: [RegExp, TurnMessageClass][] = [
  [/^after_agent hook '[^'\n]{0,256}' failed and aborted turn completion/, "hook_aborted"],
  [/\battestation\b/i, "attestation"],
  [/\b(unauthori[sz]ed|not logged in|login required|authentication|invalid api key|incorrect api key|token (?:has )?(?:expired|revoked|invalid))\b/i, "auth"],
  [/\b(unsupported[_ ](?:parameter|value|argument)|unknown[_ ]parameter|unrecognized request argument)\b/i, "unsupported_parameter"],
  [/\b(model[_ ])?provider\b/i, "provider"],
  [/\b(model_not_found|unknown model|unsupported model|model is not supported|model [^\n]{0,80}?(?:does not exist|not found|not supported|is not available|unavailable))\b/i, "model"],
  [/\b(stream disconnected|connection (?:refused|reset|closed|failed|error)|error sending request|timed out|dns error|failed to lookup address|network|tls|certificate|econnreset|econnrefused|enotfound|etimedout)\b/i, "network"],
  [/\b(internal server error|bad gateway|service unavailable|gateway timeout|server error|overloaded)\b/i, "server_error"],
];

/** Fixed set of HTTP statuses that may be lifted from message text. */
const MESSAGE_HTTP_STATUSES = new Set([400, 401, 402, 403, 404, 405, 408, 409, 413, 415, 422, 429, 500, 501, 502, 503, 504]);
const HTTP_STATUS_RE = /\b(?:status(?: code)?|http)\s*[:=]?\s*([1-5]\d{2})\b/i;

export function classifyTurnMessage(message: unknown): TurnMessageClass {
  if (typeof message !== "string" || message.length === 0) return "absent";
  const m = message.slice(0, MAX_SCANNED_MESSAGE_CHARS);
  for (const [re, cls] of PATTERNS) if (re.test(m)) return cls;
  return "unrecognized";
}

/** An HTTP status named in the message ("status 404", "HTTP 503"), only if it is in the fixed set. */
export function httpStatusFromMessage(message: unknown): number | null {
  if (typeof message !== "string") return null;
  const n = Number(HTTP_STATUS_RE.exec(message.slice(0, MAX_SCANNED_MESSAGE_CHARS))?.[1]);
  return MESSAGE_HTTP_STATUSES.has(n) ? n : null;
}

export const MAX_REDACTED_CHARS = 512;

// Applied in order; URLs before paths so a URL path is not half-redacted.
const REDACTIONS: [RegExp, string][] = [
  [/\p{Cc}/gu, " "],
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"`<>]+/gi, "<url>"],
  [/\bbearer\s+[^\s'"`]+/gi, "Bearer <redacted>"],
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|cookie)(\s*[:=]\s*)[^\s,;'"`]+/gi, "$1$2<redacted>"],
  [/\bsk-[A-Za-z0-9_-]{4,}/g, "<redacted-key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, "<redacted-jwt>"],
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g, "<email>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/(?<![\w.-])(?:~|\.{1,2})?(?:\/[^\s/'"`:,;()]+)+\/?/g, "<path>"],
  [/\b[A-Za-z]:\\[^\s'"`]*/g, "<path>"],
  [/\b[A-Za-z0-9_+=-]{32,}\b/g, "<redacted>"],
];

/**
 * Redacts credentials, emails, URLs, paths and long opaque ids from a peer
 * message and bounds its length. ONLY for the opt-in local diagnostic
 * (scripts/diagnose.mjs --task-error); never used in task results.
 */
export function redactMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  let s = message.slice(0, MAX_SCANNED_MESSAGE_CHARS);
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_REDACTED_CHARS ? s.slice(0, MAX_REDACTED_CHARS) + "…" : s;
}
