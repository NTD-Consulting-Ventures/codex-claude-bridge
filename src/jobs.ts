// Bounded async job manager: at most one active job, a bounded number of
// retained finished jobs, a wall-clock limit per job, and no retries.
//
// The wall-clock deadline and manual cancellation both abort the job signal;
// the first abort reason ("TIMEOUT" or "CANCELLED") is the root cause. A job
// stays active (BUSY) until its runner promise settles and any owned partial
// output has been removed: runners await their own filesystem work and never
// abandon it.

import { randomUUID } from "node:crypto";
import { TaskError, type TaskDiagnostic, type TaskErrorCode, type TurnOutcome } from "./session.js";

export const DEFAULT_WALL_MS = 300_000;
export const MAX_WALL_MS = 600_000;
export const MAX_COMPLETED_JOBS = 20;

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface JobView {
  job_id: string;
  kind: "task" | "image";
  state: JobState;
  started_at: string;
  finished_at: string | null;
  error: { code: TaskErrorCode; request_kind?: string; diagnostic?: TaskDiagnostic } | null;
  result: unknown;
}

interface Job {
  view: JobView;
  controller: AbortController;
  settled: Promise<void>;
  /** Set once the runner has settled; later cancel requests are refused. */
  runnerDone: boolean;
}

export type AbortCode = Extract<TaskErrorCode, "TIMEOUT" | "CANCELLED">;

/** Root cause of an aborted job signal: "TIMEOUT" when the deadline fired first, else "CANCELLED". */
export function abortCode(signal: AbortSignal): AbortCode {
  return signal.reason === "TIMEOUT" ? "TIMEOUT" : "CANCELLED";
}

/** Throws the typed root-cause error if the job signal has been aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TaskError(abortCode(signal));
}

/**
 * `own` registers cleanup of output the runner created; it is awaited (before
 * the job is released) whenever the job does not end in success.
 */
export type JobRunner = (
  signal: AbortSignal,
  timeoutMs: number,
  jobId: string,
  own: (cleanup: () => Promise<void>) => void,
) => Promise<TurnOutcome | unknown>;

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private activeId: string | undefined;

  constructor(private readonly wallMs: number = DEFAULT_WALL_MS) {
    if (!(wallMs > 0 && wallMs <= MAX_WALL_MS)) throw new RangeError("wall limit out of range");
  }

  get active(): string | undefined {
    return this.activeId;
  }

  /** Returns null when a job is already active (single-active policy). */
  start(kind: JobView["kind"], runner: JobRunner): JobView | null {
    if (this.activeId !== undefined) return null;
    this.prune();
    const controller = new AbortController();
    const view: JobView = {
      job_id: randomUUID(),
      kind,
      state: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      result: null,
    };
    this.activeId = view.job_id;
    const cleanups: (() => Promise<void>)[] = [];
    const own = (c: () => Promise<void>): void => void cleanups.push(c);
    const deadline = setTimeout(() => controller.abort("TIMEOUT"), this.wallMs);
    const job: Job = { view, controller, settled: Promise.resolve(), runnerDone: false };
    this.jobs.set(view.job_id, job);
    job.settled = (async () => {
      let ok = false;
      let result: unknown = null;
      let error: unknown;
      try {
        result = await runner(controller.signal, this.wallMs, view.job_id, own);
        ok = true;
      } catch (e) {
        error = e;
      }
      job.runnerDone = true;
      clearTimeout(deadline);
      // An abort observed before settlement (accepted cancel or deadline) wins.
      if (controller.signal.aborted) {
        const code = abortCode(controller.signal);
        if (!(error instanceof TaskError && error.code === code)) error = new TaskError(code);
        ok = false;
      }
      if (ok) {
        this.finish(view, "succeeded", null, result);
        return;
      }
      for (const c of cleanups) {
        try {
          await c();
        } catch {
          // Best effort; the owned path is never reported.
        }
      }
      const te = error instanceof TaskError ? error : new TaskError("PROTOCOL_ERROR");
      const err: NonNullable<JobView["error"]> = { code: te.code };
      if (te.requestKind !== undefined) err.request_kind = te.requestKind;
      if (te.diagnostic !== undefined) err.diagnostic = { ...te.diagnostic };
      this.finish(view, te.code === "CANCELLED" ? "cancelled" : "failed", err, null);
    })();
    return { ...view };
  }

  /**
   * Cancels the active job (if any) and waits up to `graceMs` for it to settle,
   * i.e. for its turn to be interrupted and its process termination requested.
   * Resolves true if nothing is left running.
   */
  async shutdown(graceMs: number): Promise<boolean> {
    const id = this.activeId;
    const j = id !== undefined ? this.jobs.get(id) : undefined;
    if (!j) return true;
    j.controller.abort("CANCELLED");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), graceMs);
    });
    try {
      return await Promise.race([j.settled.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  get(id: string): JobView | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.view } : undefined;
  }

  /** Cancels a running job. Returns false if unknown or already finished. */
  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.view.state !== "running" || j.runnerDone || j.controller.signal.aborted) return false;
    j.controller.abort("CANCELLED");
    return true;
  }

  private finish(view: JobView, state: JobState, error: JobView["error"], result: unknown): void {
    if (view.state !== "running") return;
    view.state = state;
    view.error = error;
    view.result = result;
    view.finished_at = new Date().toISOString();
    if (this.activeId === view.job_id) this.activeId = undefined;
  }

  private prune(): void {
    const done = [...this.jobs.values()].filter((j) => j.view.state !== "running");
    while (done.length >= MAX_COMPLETED_JOBS) {
      const old = done.shift();
      if (old) this.jobs.delete(old.view.job_id);
    }
  }
}
