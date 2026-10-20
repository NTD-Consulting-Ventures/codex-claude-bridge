// Fixed, documented mapping from a typed job error (code + whitelisted
// diagnostic enums) to two caller hints: whether trying again unchanged could
// plausibly succeed, and a coarse likely cause. Derived only from enums the
// bridge already reports; no peer text is read. It is a heuristic for the
// caller's decision, not a root cause, and the bridge itself never retries.
// Before any retry the caller should look at the job's partial_files: a failed
// or cancelled job may already have produced (and the bridge saved) images.

import type { TaskDiagnostic, TaskErrorCode } from "./session.js";

export type LikelyCause =
  | "network"
  | "server"
  | "rate_limit"
  | "quota"
  | "auth"
  | "content_policy"
  | "request"
  | "slow_generation"
  | "no_model_response"
  | "stalled"
  | "startup"
  | "approval"
  | "policy"
  | "config"
  | "session"
  | "no_image"
  | "interrupted"
  | "cancelled"
  | "local"
  | "unknown";

export interface ErrorHint {
  retryable: boolean;
  likely_cause: LikelyCause;
}

/** A turn with no event for this long before its deadline is reported as stalled rather than slow. */
export const STALL_MS = 60_000;

const NETWORK_INFO = new Set(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"]);
const SERVER_INFO = new Set(["internalServerError", "serverOverloaded", "responseTooManyFailedAttempts"]);
const POLICY_INFO = new Set(["cyberPolicy", "misalignmentPolicyViolation"]);

const hint = (retryable: boolean, likely_cause: LikelyCause): ErrorHint => ({ retryable, likely_cause });

function timeoutHint(d: TaskDiagnostic | undefined): ErrorHint {
  if (d?.phase !== "turn") return hint(true, "startup");
  // Codex kept retrying a dropped connection or a failing server until the deadline.
  const info = d.last_retry_error_info;
  const cls = d.last_retry_message_class;
  if ((info && NETWORK_INFO.has(info)) || cls === "network") return hint(true, "network");
  if ((info && SERVER_INFO.has(info)) || cls === "server_error") return hint(true, "server");
  if ((d.images_completed ?? 0) > 0) return hint(true, "slow_generation");
  if (d.first_model_event_ms === null || d.first_model_event_ms === undefined) return hint(true, "no_model_response");
  if (d.last_event_ms_ago !== undefined && d.last_event_ms_ago !== null && d.last_event_ms_ago >= STALL_MS) return hint(true, "stalled");
  return hint(true, "slow_generation");
}

function turnFailedHint(d: TaskDiagnostic | undefined): ErrorHint {
  const info = d?.codex_error_info;
  const cls = d?.turn_message_class;
  const http = d?.http_status;
  if ((info && NETWORK_INFO.has(info)) || cls === "network") return hint(true, "network");
  if ((info && SERVER_INFO.has(info)) || cls === "server_error" || (http !== undefined && http >= 500)) return hint(true, "server");
  if (info && POLICY_INFO.has(info)) return hint(false, "content_policy");
  if (info === "badRequest" || info === "contextWindowExceeded" || cls === "unsupported_parameter" || cls === "model") return hint(false, "request");
  if (info === "sandboxError") return hint(false, "policy");
  return hint(false, "unknown");
}

export function errorHint(code: TaskErrorCode, d?: TaskDiagnostic): ErrorHint {
  switch (code) {
    case "TIMEOUT":
      return timeoutHint(d);
    case "TURN_FAILED":
      return turnFailedHint(d);
    case "QUOTA_EXCEEDED":
      return d?.codex_error_info === "rateLimitExceeded" || d?.http_status === 429 ? hint(true, "rate_limit") : hint(false, "quota");
    case "AUTH_REQUIRED":
      return hint(false, "auth");
    case "APPROVAL_REQUIRED":
    case "UNSUPPORTED_SERVER_REQUEST":
      return hint(false, "approval");
    case "POLICY_MISMATCH":
      return hint(false, "policy");
    case "REFERENCE_IMAGE_INVALID":
      return hint(false, "request");
    case "MODEL_UNAVAILABLE":
    case "SPAWN_FAILED":
    case "OUTPUT_ROOT_INVALID":
    case "OUTPUT_ROOT_UNAVAILABLE":
      return hint(false, "config");
    case "INITIALIZE_FAILED":
    case "THREAD_START_FAILED":
    case "TURN_START_FAILED":
      return hint(true, "startup");
    case "PROCESS_EXITED":
      return hint(true, "local");
    case "TURN_INTERRUPTED":
      return hint(true, "interrupted");
    case "NO_IMAGE_PRODUCED":
      return hint(true, "no_image");
    case "CANCELLED":
      return hint(false, "cancelled");
    case "THREAD_RESUME_FAILED":
    case "SESSION_STALE":
    case "SESSION_INCOMPATIBLE":
      return hint(false, "session");
    case "OUTPUT_LIMIT":
    case "PROTOCOL_ERROR":
    case "IMAGE_ITEM_INVALID":
    case "IMAGE_VERIFICATION_FAILED":
      return hint(false, "local");
    default:
      return hint(false, "unknown");
  }
}
