// Job timeout configuration: one resolver shared by the server (src/server.ts)
// and the installer (src/install.ts, scripts/register.mjs).
//
// CODEX_TASK_WALL_SECONDS sets the default wall-clock limit of every job. The
// server is lenient (an existing registration keeps starting): an invalid
// value falls back to the default and a value above the maximum is capped,
// and codex_status reports which of the two happened. The installer is
// strict: it only stores a whole number of seconds in [MIN, MAX] and refuses
// anything else with a static reason that never echoes the value.
// A single job can ask for its own limit with the `timeout_s` tool argument,
// bounded by the same range.

export const JOB_TIMEOUT_ENV = "CODEX_TASK_WALL_SECONDS";
export const DEFAULT_JOB_TIMEOUT_S = 300;
export const MIN_JOB_TIMEOUT_S = 10;
export const MAX_JOB_TIMEOUT_S = 900;

export const JOB_TIMEOUT_INVALID_MESSAGE =
  `${JOB_TIMEOUT_ENV} must be a whole number of seconds between ${MIN_JOB_TIMEOUT_S} and ${MAX_JOB_TIMEOUT_S} when set (value not shown)`;

export interface JobTimeoutResolution {
  seconds: number;
  source: "default" | "env";
  /** "invalid": the env value was ignored; "capped": it was above the maximum. */
  issue: "invalid" | "capped" | null;
}

/** Server-side (lenient) resolution of the default job limit. */
export function resolveJobTimeout(env: NodeJS.ProcessEnv = process.env): JobTimeoutResolution {
  const raw = env[JOB_TIMEOUT_ENV];
  if (raw === undefined) return { seconds: DEFAULT_JOB_TIMEOUT_S, source: "default", issue: null };
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n <= 0) return { seconds: DEFAULT_JOB_TIMEOUT_S, source: "default", issue: "invalid" };
  if (n > MAX_JOB_TIMEOUT_S) return { seconds: MAX_JOB_TIMEOUT_S, source: "env", issue: "capped" };
  return { seconds: n, source: "env", issue: null };
}

/** True for an integer number of seconds a single job may ask for. */
export function isJobTimeout(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_JOB_TIMEOUT_S && v <= MAX_JOB_TIMEOUT_S;
}

export type RegisteredTimeoutChoice = { ok: true; persist: number | undefined } | { ok: false; reason: string };

/**
 * Installer-side (strict) resolution: unset stores nothing (the server then
 * uses its default); set, it must be a plain decimal integer in range.
 */
export function resolveRegisteredJobTimeout(env: NodeJS.ProcessEnv): RegisteredTimeoutChoice {
  const raw = env[JOB_TIMEOUT_ENV];
  if (raw === undefined) return { ok: true, persist: undefined };
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return { ok: false, reason: JOB_TIMEOUT_INVALID_MESSAGE };
  const n = Number(raw);
  return isJobTimeout(n) ? { ok: true, persist: n } : { ok: false, reason: JOB_TIMEOUT_INVALID_MESSAGE };
}
