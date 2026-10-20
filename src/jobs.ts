// Bounded async job manager: at most one running job, an optional bounded
// FIFO queue (opt-in per start), a bounded number of retained finished jobs, a
// wall-clock limit per job, and no retries.
//
// The wall-clock deadline and manual cancellation both abort the job signal;
// the first abort reason ("TIMEOUT" or "CANCELLED") is the root cause. A job
// stays active (BUSY) until its runner promise settles and any owned partial
// output has been handled: runners await their own filesystem work and never
// abandon it. A queued job's deadline starts only when it starts running.

import { randomUUID } from "node:crypto";
import { errorHint, type LikelyCause } from "./error-hints.js";
import type { ImageFile } from "./image-service.js";
import { DEFAULT_JOB_TIMEOUT_S, MAX_JOB_TIMEOUT_S } from "./limits.js";
import { TaskError, type Phase, type TaskDiagnostic, type TaskErrorCode, type TurnOutcome } from "./session.js";

export const DEFAULT_WALL_MS = DEFAULT_JOB_TIMEOUT_S * 1000;
export const MAX_WALL_MS = MAX_JOB_TIMEOUT_S * 1000;
export const MAX_COMPLETED_JOBS = 20;
export const MAX_QUEUED_JOBS = 8;

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Live progress of a running job (reported by its runner). */
export interface JobProgress {
  /** Lifecycle phase: spawn, initialize, model_select, thread_start, thread_resume, turn_start, turn, saving. */
  phase: string;
  /** Native image items of this turn reported completed so far. */
  images_completed: number;
  /** Verified copies already saved into the image output root (usable before the job finishes). */
  files_so_far: ImageFile[];
  /** Milliseconds from turn/start until the first model event of the turn; null until one arrives. */
  first_model_event_ms: number | null;
  /** Time of the last event received for this turn. */
  last_event_at: string | null;
}

export interface JobView {
  job_id: string;
  kind: "task" | "image";
  state: JobState;
  /** Set only for jobs that waited in the queue. */
  queued_at?: string;
  /** Null while the job is still queued. */
  started_at: string | null;
  finished_at: string | null;
  /** Wall-clock limit of this job in seconds. */
  timeout_s: number;
  error: {
    code: TaskErrorCode;
    request_kind?: string;
    diagnostic?: TaskDiagnostic;
    retryable: boolean;
    likely_cause: LikelyCause;
  } | null;
  result: unknown;
  /** Running jobs only. */
  progress?: JobProgress;
  /** Queued jobs only: 1 = next to run. */
  queue_position?: number;
  /** Failed and cancelled jobs only: verified images that were saved anyway. */
  partial_files?: ImageFile[];
}

interface Job {
  view: JobView;
  controller: AbortController;
  settled: Promise<void>;
  /** Resolves once the job has reached a final state (also for jobs cancelled while queued). */
  done: Promise<void>;
  markDone: () => void;
  /** Set once the runner has settled; later cancel requests are refused. */
  runnerDone: boolean;
  runner: JobRunner;
  onSettle: ((state: Exclude<JobState, "running" | "queued">) => void) | undefined;
  wallMs: number;
  progress: (() => JobProgress) | undefined;
}

export type AbortCode = Extract<TaskErrorCode, "TIMEOUT" | "CANCELLED">;

/** Root cause of an aborted job signal: "TIMEOUT" when the deadline fired first, else "CANCELLED". */
export function abortCode(signal: AbortSignal): AbortCode {
  return signal.reason === "TIMEOUT" ? "TIMEOUT" : "CANCELLED";
}

/** Throws the typed root-cause error if the job signal has been aborted, tagged with `phase` when given. */
export function throwIfAborted(signal: AbortSignal, phase?: Phase): void {
  if (signal.aborted) throw new TaskError(abortCode(signal), undefined, phase === undefined ? undefined : { phase });
}

/** Diagnostic fields that describe where and how far a run got; they stay valid for the abort's root cause. */
const PROGRESS_FIELDS = ["phase", "images_completed", "first_model_event_ms", "last_event_ms_ago", "retried_errors", "last_retry_error_info", "last_retry_message_class"] as const;

/**
 * `own` registers cleanup of output the runner created; it is awaited (before
 * the job is released) whenever the job does not end in success. `progress`
 * registers a getter that codex_task_status reads while the job runs.
 */
export type JobRunner = (
  signal: AbortSignal,
  timeoutMs: number,
  jobId: string,
  own: (cleanup: () => Promise<void>) => void,
  progress: (get: () => JobProgress) => void,
) => Promise<TurnOutcome | unknown>;

export interface StartOptions {
  /** Wall-clock limit of this job (default: the manager's). */
  wallMs?: number | undefined;
  /** Queue behind the running job instead of returning null (BUSY). */
  queue?: boolean;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private activeId: string | undefined;
  private closed = false;

  constructor(private readonly wallMs: number = DEFAULT_WALL_MS) {
    if (!(wallMs > 0 && wallMs <= MAX_WALL_MS)) throw new RangeError("wall limit out of range");
  }

  get active(): string | undefined {
    return this.activeId;
  }

  get defaultWallMs(): number {
    return this.wallMs;
  }

  /** Ids of queued jobs, next first. */
  get queued(): string[] {
    return this.queue.map((j) => j.view.job_id);
  }

  get queueFull(): boolean {
    return this.queue.length >= MAX_QUEUED_JOBS;
  }

  /**
   * Starts a job, or queues it when another job is running and `queue` is set.
   * Returns null when a job is running and the job was not queued (BUSY, queue
   * full or shutting down). `onSettle` receives the final state right before
   * the job is released.
   */
  start(
    kind: JobView["kind"],
    runner: JobRunner,
    onSettle?: (state: Exclude<JobState, "running" | "queued">) => void,
    opts: StartOptions = {},
  ): JobView | null {
    const wallMs = opts.wallMs ?? this.wallMs;
    if (!(wallMs > 0 && wallMs <= MAX_WALL_MS)) throw new RangeError("wall limit out of range");
    if (this.closed) return null;
    const busy = this.activeId !== undefined;
    if (busy && (!opts.queue || this.queueFull)) return null;
    this.prune();
    let markDone!: () => void;
    const done = new Promise<void>((r) => (markDone = r));
    const job: Job = {
      view: {
        job_id: randomUUID(),
        kind,
        state: busy ? "queued" : "running",
        started_at: null,
        finished_at: null,
        timeout_s: Math.round(wallMs / 1000),
        error: null,
        result: null,
      },
      controller: new AbortController(),
      settled: Promise.resolve(),
      done,
      markDone,
      runnerDone: false,
      runner,
      onSettle,
      wallMs,
      progress: undefined,
    };
    this.jobs.set(job.view.job_id, job);
    if (busy) {
      job.view.queued_at = new Date().toISOString();
      this.queue.push(job);
    } else {
      this.run(job);
    }
    return this.view(job);
  }

  private run(job: Job): void {
    const { view, controller } = job;
    view.state = "running";
    view.started_at = new Date().toISOString();
    this.activeId = view.job_id;
    const cleanups: (() => Promise<void>)[] = [];
    const own = (c: () => Promise<void>): void => void cleanups.push(c);
    const progress = (get: () => JobProgress): void => void (job.progress = get);
    const deadline = setTimeout(() => controller.abort("TIMEOUT"), job.wallMs);
    job.settled = (async () => {
      let ok = false;
      let result: unknown = null;
      let error: unknown;
      try {
        result = await job.runner(controller.signal, job.wallMs, view.job_id, own, progress);
        ok = true;
      } catch (e) {
        error = e;
      }
      job.runnerDone = true;
      clearTimeout(deadline);
      // An abort observed before settlement (accepted cancel or deadline) wins, unless the
      // runner had already determined its own failure before the abort (e.g. during salvage).
      const decided = error instanceof TaskError && error.decided === true;
      if (controller.signal.aborted && !decided) {
        const code = abortCode(controller.signal);
        if (!(error instanceof TaskError && error.code === code)) {
          // A different code (e.g. the killed process exiting) is not the root cause; saved files and
          // where the run got to (phase, timing) carry over, other diagnostic details do not.
          const next = new TaskError(code);
          if (error instanceof TaskError) {
            next.partialFiles = error.partialFiles;
            const d = error.diagnostic;
            if (d) next.diagnostic = Object.fromEntries(PROGRESS_FIELDS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])) as unknown as TaskDiagnostic;
          }
          error = next;
        }
        ok = false;
      }
      if (ok) {
        this.settle(job, "succeeded");
        this.finish(job, "succeeded", null, result);
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
      const state = te.code === "CANCELLED" ? "cancelled" : "failed";
      this.settle(job, state);
      this.finish(job, state, errorView(te), null, te.partialFiles ?? []);
    })();
  }

  private settle(job: Job, state: Exclude<JobState, "running" | "queued">): void {
    try {
      job.onSettle?.(state);
    } catch {
      // Observer faults must not keep the job active.
    }
  }

  /**
   * Cancels queued jobs and the running job (if any) and waits up to
   * `graceMs` for the running one to settle, i.e. for its turn to be
   * interrupted and its process termination requested. No queued job starts
   * afterwards. Resolves true if nothing is left running.
   */
  async shutdown(graceMs: number): Promise<boolean> {
    this.closed = true;
    for (const q of this.queue.splice(0)) this.cancelQueued(q);
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
    return j ? this.view(j) : undefined;
  }

  /**
   * Resolves once the job is finished or `ms` have passed (or `signal` aborts).
   * Returns the current view, or undefined for an unknown job.
   */
  async wait(id: string, ms: number, signal?: AbortSignal): Promise<JobView | undefined> {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.view.state !== "running" && j.view.state !== "queued") return this.view(j);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      j.done,
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
        onAbort = r;
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    return this.view(j);
  }

  /** The most recently finished retained job matching `pred`. */
  lastFinished(pred: (v: JobView) => boolean = () => true): JobView | undefined {
    let best: Job | undefined;
    for (const j of this.jobs.values()) {
      if (j.view.finished_at === null || !pred(j.view)) continue;
      if (!best || j.view.finished_at >= best.view.finished_at!) best = j;
    }
    return best ? this.view(best) : undefined;
  }

  /** Cancels a queued or running job. Returns false if unknown or already finished. */
  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.view.state === "queued") {
      const i = this.queue.indexOf(j);
      if (i >= 0) this.queue.splice(i, 1);
      this.cancelQueued(j);
      return true;
    }
    if (j.view.state !== "running" || j.runnerDone || j.controller.signal.aborted) return false;
    j.controller.abort("CANCELLED");
    return true;
  }

  private cancelQueued(j: Job): void {
    j.controller.abort("CANCELLED");
    j.runnerDone = true;
    this.settle(j, "cancelled");
    this.finish(j, "cancelled", errorView(new TaskError("CANCELLED")), null, []);
  }

  private view(j: Job): JobView {
    const v: JobView = { ...j.view };
    if (v.state === "running" && j.progress) {
      try {
        v.progress = j.progress();
      } catch {
        // Progress is best effort.
      }
    }
    if (v.state === "queued") v.queue_position = this.queue.indexOf(j) + 1;
    return v;
  }

  private finish(job: Job, state: JobState, error: JobView["error"], result: unknown, partial?: ImageFile[]): void {
    const view = job.view;
    if (view.state !== "running" && view.state !== "queued") return;
    view.state = state;
    view.error = error;
    view.result = result;
    if (partial !== undefined) view.partial_files = partial;
    view.finished_at = new Date().toISOString();
    job.progress = undefined;
    job.markDone();
    if (this.activeId === view.job_id) {
      this.activeId = undefined;
      const next = this.closed ? undefined : this.queue.shift();
      if (next) this.run(next);
    }
  }

  private prune(): void {
    const done = [...this.jobs.values()].filter((j) => j.view.state !== "running" && j.view.state !== "queued");
    while (done.length >= MAX_COMPLETED_JOBS) {
      const old = done.shift();
      if (old) this.jobs.delete(old.view.job_id);
    }
  }
}

function errorView(te: TaskError): NonNullable<JobView["error"]> {
  const err: NonNullable<JobView["error"]> = { code: te.code, retryable: false, likely_cause: "unknown" };
  if (te.requestKind !== undefined) err.request_kind = te.requestKind;
  if (te.diagnostic !== undefined) err.diagnostic = { ...te.diagnostic };
  const h = errorHint(te.code, te.diagnostic);
  err.retryable = h.retryable;
  err.likely_cause = h.likely_cause;
  return err;
}
