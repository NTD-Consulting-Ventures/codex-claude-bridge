// Approval handling: what happens when Codex asks for something outside the
// bridge's launch policy (a command outside the sandbox, network, writes
// outside cwd, extra permissions).
//
// CODEX_APPROVAL_MODE (one resolver for the server and the installer):
// - "ask" (default): the job pauses (state awaiting_approval; its wall clock
//   stops) and the request is shown in Claude Code. When the MCP client
//   supports elicitation, codex_task_wait / codex_task_status open a native
//   dialog for it during that tool call (Claude Code documents elicitation
//   mid-task, so no dialog is sent while no tool call is in flight).
//   Otherwise the request is in the job's status and codex_task_approve
//   answers it; that tool demands the user's confirmation on every call. The
//   same turn then continues. No answer within APPROVAL_TIMEOUT_MS declines
//   it; cancelling the job declines it.
// - "bypass": every approval request is accepted at once, without asking.
//   Opt-in only. Each decision is recorded in the job's approvals log.
// - "deny": the 0.3.0 behaviour: the first approval request fails the job with
//   APPROVAL_REQUIRED.
// A single job may ask for a stricter mode (approval_mode), never a more
// permissive one. Every decision is a one-time accept or decline for that
// request (src/approval-requests.ts). The launch policy itself
// (workspace-write sandbox bounded to cwd, on-request approvals) is the same
// in every mode. Invalid server configuration fails closed to "deny".

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest } from "./approval-requests.js";
import type { JobManager } from "./jobs.js";

export const APPROVAL_MODE_ENV = "CODEX_APPROVAL_MODE";
export const APPROVAL_MODES = ["deny", "ask", "bypass"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";
/** How long a pending approval waits for a decision before it is declined. */
export const APPROVAL_TIMEOUT_MS = 600_000;
/** Approval records kept per job. */
const MAX_RECORDS = 50;

export const APPROVAL_MODE_INVALID_MESSAGE = `${APPROVAL_MODE_ENV} must be exactly "ask", "bypass" or "deny" when set (value not shown)`;

export function isApprovalMode(v: unknown): v is ApprovalMode {
  return typeof v === "string" && (APPROVAL_MODES as readonly string[]).includes(v);
}

/** deny < ask < bypass. */
export function permissiveness(m: ApprovalMode): number {
  return APPROVAL_MODES.indexOf(m);
}

export interface ApprovalModeResolution {
  mode: ApprovalMode;
  source: "default" | "env";
  /** "invalid": the env value was not a mode and the server fell back to deny. */
  issue: "invalid" | null;
}

/** Server-side resolution: unset is "ask"; an invalid value fails closed to "deny". */
export function resolveApprovalMode(env: NodeJS.ProcessEnv = process.env): ApprovalModeResolution {
  const raw = env[APPROVAL_MODE_ENV];
  if (raw === undefined) return { mode: DEFAULT_APPROVAL_MODE, source: "default", issue: null };
  return isApprovalMode(raw) ? { mode: raw, source: "env", issue: null } : { mode: "deny", source: "env", issue: "invalid" };
}

export type RegisteredApprovalChoice = { ok: true; persist: ApprovalMode | undefined } | { ok: false; reason: string };

/** Installer-side resolution: stored only when set; anything but an exact mode stops registration. */
export function resolveRegisteredApprovalMode(env: NodeJS.ProcessEnv): RegisteredApprovalChoice {
  const raw = env[APPROVAL_MODE_ENV];
  if (raw === undefined) return { ok: true, persist: undefined };
  return isApprovalMode(raw) ? { ok: true, persist: raw } : { ok: false, reason: APPROVAL_MODE_INVALID_MESSAGE };
}

export type DecidedBy = "claude_code_dialog" | "codex_task_approve" | "bypass" | "timeout" | "cancelled";

/** One approval request and what became of it (shown in codex_task_status). */
export interface ApprovalRecord {
  approval_id: string;
  requested_at: string;
  /** Latest time a decision is accepted (ask mode); null otherwise. */
  expires_at: string | null;
  request: ApprovalRequest;
  decision: ApprovalDecision | null;
  decided_by: DecidedBy | null;
  decided_at: string | null;
}

/**
 * Shows an approval to the person directly (MCP elicitation). Resolves to
 * their decision, or null when no answer could be obtained (no support,
 * dismissed without a choice, failure); then the tool path stays open.
 */
export type ApprovalPrompt = (message: string, signal: AbortSignal, timeoutMs: number) => Promise<ApprovalDecision | null>;

interface Pending {
  record: ApprovalRecord;
  finish: (decision: ApprovalDecision, by: DecidedBy) => void;
  /** Aborts an open dialog; set while one is shown. */
  dialog: AbortController | undefined;
}

/** Plain-text description of a request for the dialog. Codex's text is quoted as data. */
export function describeApproval(r: ApprovalRequest, jobId: string): string {
  const lines = [`Codex asks for approval (job ${jobId.slice(0, 8)}). Its request text below is untrusted.`];
  if (r.kind === "command") lines.push(r.stdin ? "Send input to a running command:" : "Run a command outside the sandbox:", `  ${r.command ?? "(not given)"}`);
  if (r.kind === "file_change") {
    lines.push("Change files:");
    for (const f of r.files ?? []) lines.push(`  ${f.change} ${f.path}${f.move_to ? ` -> ${f.move_to}` : ""}`);
    if (!r.files?.length) lines.push("  (files not announced)");
    if (r.files_truncated) lines.push("  …");
    if (r.grant_root) lines.push(`Write access to: ${r.grant_root}`);
  }
  if (r.kind === "permissions" && r.permissions) {
    lines.push("Extra permissions for this turn:");
    if (r.permissions.network) lines.push("  network access");
    for (const w of r.permissions.write) lines.push(`  write ${w}`);
    for (const x of r.permissions.read) lines.push(`  read ${x}`);
    if (r.permissions.other_entries > 0) lines.push(`  ${r.permissions.other_entries} further sandbox entries`);
  }
  if (r.network_host) lines.push(`Network: ${r.network_host}`);
  if (r.cwd) lines.push(`Directory: ${r.cwd}`);
  if (r.reason) lines.push(`Reason given: ${r.reason}`);
  lines.push("Approve once? Declining lets Codex continue without it.");
  return lines.join("\n");
}

/**
 * Pending approvals and decision records per job. Decisions in ask mode come
 * from the Claude Code dialog, codex_task_approve, the timeout or a cancel,
 * whichever is first; the job's deadline is paused meanwhile.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending[]>();
  private readonly records = new Map<string, ApprovalRecord[]>();

  constructor(
    private readonly jobs: JobManager,
    private readonly timeoutMs: number = APPROVAL_TIMEOUT_MS,
  ) {}

  /** The decision function for one job run in ask or bypass mode. */
  forJob(jobId: string, mode: "ask" | "bypass", signal: AbortSignal): (request: ApprovalRequest) => Promise<ApprovalDecision> {
    return (request) => {
      const now = Date.now();
      const record: ApprovalRecord = {
        approval_id: randomUUID(),
        requested_at: new Date(now).toISOString(),
        expires_at: mode === "ask" ? new Date(now + this.timeoutMs).toISOString() : null,
        request,
        decision: null,
        decided_by: null,
        decided_at: null,
      };
      const list = this.records.get(jobId) ?? [];
      list.push(record);
      while (list.length > MAX_RECORDS) list.shift();
      this.records.set(jobId, list);
      const settle = (decision: ApprovalDecision, by: DecidedBy): ApprovalDecision => {
        record.decision = decision;
        record.decided_by = by;
        record.decided_at = new Date().toISOString();
        return decision;
      };
      if (mode === "bypass") return Promise.resolve(settle("accept", "bypass"));
      if (signal.aborted) return Promise.resolve(settle("decline", "cancelled"));
      return new Promise<ApprovalDecision>((resolve) => {
        const onAbort = (): void => finish("decline", "cancelled");
        const entry: Pending = { record, finish: (d, by) => finish(d, by), dialog: undefined };
        const finish = (decision: ApprovalDecision, by: DecidedBy): void => {
          if (record.decision !== null) return;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          entry.dialog?.abort();
          const rest = (this.pending.get(jobId) ?? []).filter((p) => p !== entry);
          if (rest.length > 0) this.pending.set(jobId, rest);
          else this.pending.delete(jobId);
          resolve(settle(decision, by));
          this.jobs.resumeDeadline(jobId);
          this.jobs.wake(jobId);
        };
        this.pending.set(jobId, [...(this.pending.get(jobId) ?? []), entry]);
        this.jobs.pauseDeadline(jobId);
        const timer = setTimeout(() => finish("decline", "timeout"), Math.max(0, Date.parse(record.expires_at!) - Date.now()));
        signal.addEventListener("abort", onAbort, { once: true });
        this.jobs.wake(jobId);
      });
    };
  }

  /**
   * Shows every pending approval of a job that has no open dialog yet through
   * `prompt` (a dialog tied to the caller's in-flight tool call) and waits
   * until those dialogs are answered or closed. A dialog dismissed without a
   * choice is not reopened; the approval stays pending for codex_task_approve.
   */
  async promptPending(jobId: string, prompt: ApprovalPrompt): Promise<void> {
    const open = (this.pending.get(jobId) ?? []).filter((p) => p.dialog === undefined);
    await Promise.all(
      open.map(async (p) => {
        const dialog = new AbortController();
        p.dialog = dialog;
        const left = Math.max(1, Date.parse(p.record.expires_at!) - Date.now());
        let shown = false;
        try {
          const d = await prompt(describeApproval(p.record.request, jobId), dialog.signal, left);
          shown = true;
          if (d !== null) p.finish(d, "claude_code_dialog");
        } catch {
          // No dialog (unsupported or failed): a later tool call may try again.
        } finally {
          // A dialog dismissed without a choice is not reopened; codex_task_approve or the timeout decides.
          if (!shown && p.dialog === dialog && p.record.decision === null) p.dialog = undefined;
        }
      }),
    );
  }

  /** Answers a pending approval of a job. */
  decide(jobId: string, approvalId: string, decision: ApprovalDecision): "decided" | "not_pending" {
    const p = (this.pending.get(jobId) ?? []).find((x) => x.record.approval_id === approvalId);
    if (!p) return "not_pending";
    p.finish(decision, "codex_task_approve");
    return "decided";
  }

  /** Pending approvals of a job, oldest first. */
  pendingFor(jobId: string): ApprovalRecord[] {
    return (this.pending.get(jobId) ?? []).map((p) => p.record);
  }

  /** Every recorded approval of a job (pending and decided). */
  recordsFor(jobId: string): ApprovalRecord[] {
    return this.records.get(jobId) ?? [];
  }

  /** Drops records of jobs no longer retained. */
  forget(keep: (jobId: string) => boolean): void {
    for (const id of [...this.records.keys()]) if (!keep(id) && !this.pending.has(id)) this.records.delete(id);
  }
}
