// Bounded async job manager: at most one active job, a bounded number of
// retained finished jobs, a wall-clock limit per job, and no retries.

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
}

export type JobRunner = (signal: AbortSignal, timeoutMs: number, jobId: string) => Promise<TurnOutcome | unknown>;

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
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(runner(controller.signal, this.wallMs, view.job_id));
    } catch (e) {
      p = Promise.reject(e);
    }
    const settled = p.then(
      (result) => this.finish(view, "succeeded", null, result),
      (e: unknown) => {
        const te = e instanceof TaskError ? e : new TaskError("PROTOCOL_ERROR");
        const err: NonNullable<JobView["error"]> = { code: te.code };
        if (te.requestKind !== undefined) err.request_kind = te.requestKind;
        if (te.diagnostic !== undefined) err.diagnostic = { ...te.diagnostic };
        this.finish(view, te.code === "CANCELLED" ? "cancelled" : "failed", err, null);
      },
    );
    this.jobs.set(view.job_id, { view, controller, settled });
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
    j.controller.abort();
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
    if (!j || j.view.state !== "running") return false;
    j.controller.abort();
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
