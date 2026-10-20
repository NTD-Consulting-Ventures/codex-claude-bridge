// Codex approval requests (server-initiated JSON-RPC requests) as the bridge
// sees them: which methods are approvals, a bounded summary of what is being
// asked for, and the protocol response for a one-time accept or decline.
//
// Shapes follow the codex-cli 0.162.1 app-server schema:
// - v2 item/commandExecution/requestApproval -> {decision: "accept" | "decline"}
// - v2 item/fileChange/requestApproval       -> {decision: "accept" | "decline"}
// - v2 item/permissions/requestApproval      -> {permissions, scope: "turn"}
// - v1 execCommandApproval / applyPatchApproval -> {decision: "approved" | {denied: {rejection}}}
// Only one-time decisions are ever sent: never acceptForSession, never an
// execpolicy or network policy amendment, never a session-scoped permission
// grant, so nothing an approval decides outlives the turn or changes the
// user's Codex configuration.
//
// The summary carries Codex's own request text (command line, reason, paths)
// so a person can decide. It is bounded and stripped of control characters,
// but it is untrusted: it can contain text written to persuade a reader.

export const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";
export const PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
export const LEGACY_EXEC_APPROVAL = "execCommandApproval";
export const LEGACY_PATCH_APPROVAL = "applyPatchApproval";

/** Server requests that are approvals (answerable in ask / bypass mode). */
export const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  COMMAND_APPROVAL,
  FILE_CHANGE_APPROVAL,
  PERMISSIONS_APPROVAL,
  LEGACY_EXEC_APPROVAL,
  LEGACY_PATCH_APPROVAL,
]);

export type ApprovalDecision = "accept" | "decline";

/** Fixed rejection text of a legacy (v1) denial; never caller-supplied. */
export const LEGACY_REJECTION = "Declined by the user through codex-claude-bridge.";
export type ApprovalKind = "command" | "file_change" | "permissions";

export interface ApprovalFile {
  path: string;
  change: "add" | "delete" | "update";
  move_to?: string;
}

/** What Codex asks for, bounded. Field values are Codex's own (untrusted) text. */
export interface ApprovalRequest {
  kind: ApprovalKind;
  /** The command line (command approvals). */
  command?: string;
  /** True when the approval is for input to an already running command rather than a new command. */
  stdin?: boolean;
  cwd?: string;
  reason?: string;
  /** Network access the command needs (managed-network approvals). */
  network_host?: string;
  /** Files a file-change approval would write. */
  files?: ApprovalFile[];
  files_truncated?: boolean;
  /** Extra writable root a file-change approval asks for. */
  grant_root?: string;
  /** Extra sandbox permissions (permission approvals). */
  permissions?: { network: boolean; read: string[]; write: string[]; other_entries: number };
}

const MAX_COMMAND_CHARS = 2_000;
const MAX_TEXT_CHARS = 500;
const MAX_PATH_CHARS = 1_024;
const MAX_FILES = 25;
const MAX_PATHS = 25;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Control characters become spaces; the text is trimmed and cut to `max` characters. */
export function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\p{Cc}/gu, " ").trim();
  if (s.length === 0) return undefined;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_PATHS).flatMap((x) => {
    const c = clean(x, MAX_PATH_CHARS);
    return c === undefined ? [] : [c];
  });
}

/** File changes Codex announced for an item (item/started fileChange), bounded. */
export function fileChangesOf(item: Record<string, unknown>): { files: ApprovalFile[]; truncated: boolean } {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files: ApprovalFile[] = [];
  for (const c of changes.slice(0, MAX_FILES)) {
    const o = obj(c);
    const p = clean(o?.path, MAX_PATH_CHARS);
    const kind = obj(o?.kind)?.type;
    if (p === undefined || (kind !== "add" && kind !== "delete" && kind !== "update")) continue;
    const f: ApprovalFile = { path: p, change: kind };
    const move = clean(obj(o?.kind)?.move_path, MAX_PATH_CHARS);
    if (move !== undefined) f.move_to = move;
    files.push(f);
  }
  return { files, truncated: changes.length > MAX_FILES };
}

function legacyFiles(v: unknown): { files: ApprovalFile[]; truncated: boolean } {
  const o = obj(v);
  if (!o) return { files: [], truncated: false };
  const keys = Object.keys(o);
  const files: ApprovalFile[] = [];
  for (const k of keys.slice(0, MAX_FILES)) {
    const p = clean(k, MAX_PATH_CHARS);
    const t = obj(o[k])?.type;
    if (p === undefined) continue;
    files.push({ path: p, change: t === "add" || t === "delete" ? t : "update" });
  }
  return { files, truncated: keys.length > MAX_FILES };
}

/**
 * Bounded summary of an approval request, or null when the params do not have
 * the expected shape (the request is then denied). `knownFiles` resolves a v2
 * file-change approval's itemId to the changes announced for that item.
 */
export function summarizeApproval(
  method: string,
  params: unknown,
  knownFiles: (itemId: string) => { files: ApprovalFile[]; truncated: boolean } | undefined = () => undefined,
): ApprovalRequest | null {
  const p = obj(params);
  if (!p) return null;
  const set = <K extends keyof ApprovalRequest>(r: ApprovalRequest, k: K, v: ApprovalRequest[K] | undefined): void => {
    if (v !== undefined) r[k] = v;
  };
  switch (method) {
    case COMMAND_APPROVAL: {
      const r: ApprovalRequest = { kind: "command" };
      set(r, "command", clean(p.command, MAX_COMMAND_CHARS));
      if (p.kind === "writeStdin") r.stdin = true;
      set(r, "cwd", clean(p.cwd, MAX_PATH_CHARS));
      set(r, "reason", clean(p.reason, MAX_TEXT_CHARS));
      set(r, "network_host", clean(obj(p.networkApprovalContext)?.host, MAX_TEXT_CHARS));
      return r;
    }
    case LEGACY_EXEC_APPROVAL: {
      const r: ApprovalRequest = { kind: "command" };
      const cmd = Array.isArray(p.command) ? p.command.filter((x) => typeof x === "string").join(" ") : p.command;
      set(r, "command", clean(cmd, MAX_COMMAND_CHARS));
      set(r, "cwd", clean(p.cwd, MAX_PATH_CHARS));
      set(r, "reason", clean(p.reason, MAX_TEXT_CHARS));
      return r;
    }
    case FILE_CHANGE_APPROVAL: {
      const r: ApprovalRequest = { kind: "file_change" };
      const known = typeof p.itemId === "string" ? knownFiles(p.itemId) : undefined;
      if (known) {
        r.files = known.files;
        if (known.truncated) r.files_truncated = true;
      }
      set(r, "reason", clean(p.reason, MAX_TEXT_CHARS));
      set(r, "grant_root", clean(p.grantRoot, MAX_PATH_CHARS));
      return r;
    }
    case LEGACY_PATCH_APPROVAL: {
      const r: ApprovalRequest = { kind: "file_change" };
      const lf = legacyFiles(p.fileChanges);
      r.files = lf.files;
      if (lf.truncated) r.files_truncated = true;
      set(r, "reason", clean(p.reason, MAX_TEXT_CHARS));
      set(r, "grant_root", clean(p.grantRoot, MAX_PATH_CHARS));
      return r;
    }
    case PERMISSIONS_APPROVAL: {
      const perm = obj(p.permissions);
      if (!perm) return null;
      const fs = obj(perm.fileSystem);
      const entries = Array.isArray(fs?.entries) ? fs.entries.length : 0;
      const r: ApprovalRequest = {
        kind: "permissions",
        permissions: { network: obj(perm.network)?.enabled === true, read: cleanList(fs?.read), write: cleanList(fs?.write), other_entries: entries },
      };
      set(r, "cwd", clean(p.cwd, MAX_PATH_CHARS));
      set(r, "reason", clean(p.reason, MAX_TEXT_CHARS));
      return r;
    }
    default:
      return null;
  }
}

/** The protocol response for a one-time decision. Never session-scoped, never an amendment. */
export function approvalResponse(method: string, params: unknown, decision: ApprovalDecision): unknown {
  switch (method) {
    case COMMAND_APPROVAL:
    case FILE_CHANGE_APPROVAL:
      return { decision };
    case PERMISSIONS_APPROVAL: {
      // Accept grants exactly what was requested, for this turn only; decline grants nothing.
      const requested = obj(obj(params)?.permissions) ?? {};
      const granted: Record<string, unknown> = {};
      if (decision === "accept") {
        if (requested.fileSystem !== undefined) granted.fileSystem = requested.fileSystem;
        if (requested.network !== undefined) granted.network = requested.network;
      }
      return { permissions: granted, scope: "turn" };
    }
    case LEGACY_EXEC_APPROVAL:
    case LEGACY_PATCH_APPROVAL:
      return { decision: decision === "accept" ? "approved" : { denied: { rejection: LEGACY_REJECTION } } };
    default:
      return { decision: "decline" };
  }
}

/**
 * Whether a request belongs to the run's own thread (and turn, once known).
 * v2 requests name threadId/turnId; v1 requests name conversationId.
 */
export function approvalInScope(method: string, params: unknown, threadId: string | undefined, turnId: string | undefined): boolean {
  const p = obj(params);
  if (!p || threadId === undefined) return false;
  if (method === LEGACY_EXEC_APPROVAL || method === LEGACY_PATCH_APPROVAL) return p.conversationId === threadId;
  if (p.threadId !== threadId) return false;
  return turnId === undefined || p.turnId === undefined || p.turnId === turnId;
}
