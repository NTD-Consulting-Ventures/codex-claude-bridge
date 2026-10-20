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
// so a person can decide. Control characters become spaces and invisible or
// format characters (bidi controls, zero-width and tag characters, line and
// paragraph separators, private-use and unassigned code points) are shown as
// visible \u{...} escapes. It is still untrusted: it can contain text written
// to persuade a reader. A request whose relevant parts cannot all be shown
// (a cut command, more files or sandbox entries than are listed, an unknown
// entry shape, files never announced) is marked `complete: false`; ask mode
// declines such requests without showing them.

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

/** One sandbox entry of a permission request: access plus a readable target. */
export interface ApprovalEntry {
  access: "read" | "write" | "deny";
  /** A path, `glob:<pattern>` or `special:<kind>[ <path>]` (e.g. `special:root` = the whole filesystem). */
  target: string;
}

/** What Codex asks for, bounded. Field values are Codex's own (untrusted) text. */
export interface ApprovalRequest {
  kind: ApprovalKind;
  /** False when something that matters for the decision could not be shown in full. */
  complete: boolean;
  /** One line with everything shown, which codex_task_approve must echo (request_summary). */
  summary: string;
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
  /** Extra sandbox permissions (permission approvals), every entry listed. */
  permissions?: { network: boolean; read: string[]; write: string[]; entries: ApprovalEntry[] };
}

const MAX_COMMAND_CHARS = 2_000;
const MAX_TEXT_CHARS = 500;
const MAX_PATH_CHARS = 1_024;
const MAX_FILES = 25;
const MAX_PATHS = 25;
const MAX_SUMMARY_CHARS = 4_000;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Invisible or format characters a reader would not see, shown as visible escapes. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;

/**
 * Control characters become spaces, invisible characters visible \u{...}
 * escapes; the text is trimmed. `cut` is set when it was longer than `max`
 * (the text then ends with "…").
 */
export function cleanText(v: unknown, max: number): { text: string; cut: boolean } | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .replace(/\p{Cc}/gu, " ")
    .replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
    .trim();
  if (s.length === 0) return undefined;
  return s.length > max ? { text: s.slice(0, max) + "…", cut: true } : { text: s, cut: false };
}

/** cleanText without the cut flag (for text that is informative only). */
export function clean(v: unknown, max: number): string | undefined {
  return cleanText(v, max)?.text;
}

/** File changes Codex announced for an item (item/started, item/updated, patchUpdated), bounded. */
export function fileChangesOf(item: Record<string, unknown>): { files: ApprovalFile[]; truncated: boolean } {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files: ApprovalFile[] = [];
  let truncated = changes.length > MAX_FILES;
  for (const c of changes.slice(0, MAX_FILES)) {
    const o = obj(c);
    const p = cleanText(o?.path, MAX_PATH_CHARS);
    const kind = obj(o?.kind)?.type;
    if (p === undefined || p.cut || (kind !== "add" && kind !== "delete" && kind !== "update")) {
      truncated = true;
      continue;
    }
    const f: ApprovalFile = { path: p.text, change: kind };
    const moveRaw = obj(o?.kind)?.move_path;
    if (moveRaw !== undefined && moveRaw !== null) {
      const move = cleanText(moveRaw, MAX_PATH_CHARS);
      if (move === undefined || move.cut) truncated = true;
      else f.move_to = move.text;
    }
    files.push(f);
  }
  return { files, truncated };
}

function legacyFiles(v: unknown): { files: ApprovalFile[]; truncated: boolean } {
  const o = obj(v);
  if (!o) return { files: [], truncated: true };
  const keys = Object.keys(o);
  const files: ApprovalFile[] = [];
  let truncated = keys.length > MAX_FILES || keys.length === 0;
  for (const k of keys.slice(0, MAX_FILES)) {
    const p = cleanText(k, MAX_PATH_CHARS);
    const t = obj(o[k])?.type;
    if (p === undefined || p.cut) {
      truncated = true;
      continue;
    }
    files.push({ path: p.text, change: t === "add" || t === "delete" ? t : "update" });
  }
  return { files, truncated };
}

/** A list of paths, all shown or flagged incomplete. */
function pathList(v: unknown): { paths: string[]; complete: boolean } {
  if (v === undefined || v === null) return { paths: [], complete: true };
  if (!Array.isArray(v)) return { paths: [], complete: false };
  const paths: string[] = [];
  let complete = v.length <= MAX_PATHS;
  for (const x of v.slice(0, MAX_PATHS)) {
    const c = cleanText(x, MAX_PATH_CHARS);
    if (c === undefined || c.cut) complete = false;
    else paths.push(c.text);
  }
  return { paths, complete };
}

/** A FileSystemSandboxEntry as access + readable target; null when its shape is unknown. */
function entryOf(v: unknown): ApprovalEntry | null {
  const o = obj(v);
  const access = o?.access;
  if (access !== "read" && access !== "write" && access !== "deny") return null;
  const path = obj(o?.path);
  // Every part must be shown uncut; an optional part that is present but unreadable makes the entry unknown.
  const part = (x: unknown, optional: boolean): string | null | undefined => {
    if (optional && (x === undefined || x === null)) return undefined;
    const c = cleanText(x, MAX_PATH_CHARS);
    return c === undefined || c.cut ? null : c.text;
  };
  let target: string | null = null;
  if (path?.type === "path") target = part(path.path, false) ?? null;
  else if (path?.type === "glob_pattern") {
    const g = part(path.pattern, false);
    target = g ? `glob:${g}` : null;
  } else if (path?.type === "special") {
    const val = obj(path.value);
    const kind = part(val?.kind, false);
    const extra = [part(val?.path, true), part(val?.subpath, true)];
    if (kind && !extra.includes(null)) target = [`special:${kind}`, ...extra.filter((x): x is string => typeof x === "string")].join(" ");
  }
  return target ? { access, target } : null;
}

/** Joins summary parts; null when the line would be too long to show in full. */
function summaryLine(parts: (string | undefined)[]): string | null {
  const line = parts.filter((x): x is string => x !== undefined && x.length > 0).join(" | ");
  return line.length > MAX_SUMMARY_CHARS ? null : line;
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
  const reason = clean(p.reason, MAX_TEXT_CHARS);
  const cwdText = cleanText(p.cwd, MAX_PATH_CHARS);
  const finish = (r: Omit<ApprovalRequest, "summary">, parts: (string | undefined)[]): ApprovalRequest => {
    const line = summaryLine(parts);
    const out: ApprovalRequest = { ...r, summary: line ?? "(too long to show)" };
    if (line === null) out.complete = false;
    if (reason !== undefined) out.reason = reason;
    return out;
  };
  const filesText = (files: ApprovalFile[]): string => files.map((f) => `${f.change} ${f.path}${f.move_to ? ` -> ${f.move_to}` : ""}`).join("; ");
  switch (method) {
    case COMMAND_APPROVAL:
    case LEGACY_EXEC_APPROVAL: {
      const raw = method === LEGACY_EXEC_APPROVAL && Array.isArray(p.command) ? p.command.filter((x) => typeof x === "string").join(" ") : p.command;
      const cmd = cleanText(raw, MAX_COMMAND_CHARS);
      const r: Omit<ApprovalRequest, "summary"> = { kind: "command", complete: cmd !== undefined && !cmd.cut && cwdText?.cut !== true };
      if (cmd) r.command = cmd.text;
      if (method === COMMAND_APPROVAL && p.kind === "writeStdin") r.stdin = true;
      if (cwdText) r.cwd = cwdText.text;
      const host = method === COMMAND_APPROVAL ? cleanText(obj(p.networkApprovalContext)?.host, MAX_TEXT_CHARS) : undefined;
      if (host) {
        r.network_host = host.text;
        if (host.cut) r.complete = false;
      }
      return finish(r, [`${r.stdin ? "stdin" : "run"}: ${r.command ?? "(not given)"}`, r.cwd && `in: ${r.cwd}`, r.network_host && `network: ${r.network_host}`]);
    }
    case FILE_CHANGE_APPROVAL:
    case LEGACY_PATCH_APPROVAL: {
      const known = method === LEGACY_PATCH_APPROVAL ? legacyFiles(p.fileChanges) : typeof p.itemId === "string" ? knownFiles(p.itemId) : undefined;
      const root = p.grantRoot === undefined || p.grantRoot === null ? undefined : cleanText(p.grantRoot, MAX_PATH_CHARS);
      const r: Omit<ApprovalRequest, "summary"> = {
        kind: "file_change",
        complete: known !== undefined && !known.truncated && known.files.length > 0 && root?.cut !== true && !(p.grantRoot !== undefined && p.grantRoot !== null && root === undefined),
        files: known?.files ?? [],
      };
      if (known?.truncated) r.files_truncated = true;
      if (root) r.grant_root = root.text;
      return finish(r, [`files: ${known?.files.length ? filesText(known.files) : "(not announced)"}`, r.grant_root && `write root: ${r.grant_root}`]);
    }
    case PERMISSIONS_APPROVAL: {
      const perm = obj(p.permissions);
      if (!perm) return null;
      const fs = obj(perm.fileSystem);
      const read = pathList(fs?.read);
      const write = pathList(fs?.write);
      const rawEntries = fs?.entries === undefined || fs?.entries === null ? [] : Array.isArray(fs.entries) ? fs.entries : null;
      const entries = (rawEntries ?? []).slice(0, MAX_PATHS).map(entryOf);
      const shownEntries = entries.filter((e): e is ApprovalEntry => e !== null);
      const network = obj(perm.network)?.enabled === true;
      const knownKeys = Object.keys(perm).every((k) => k === "fileSystem" || k === "network");
      const r: Omit<ApprovalRequest, "summary"> = {
        kind: "permissions",
        complete:
          knownKeys &&
          read.complete &&
          write.complete &&
          rawEntries !== null &&
          rawEntries.length <= MAX_PATHS &&
          shownEntries.length === entries.length &&
          cwdText?.cut !== true,
        permissions: { network, read: read.paths, write: write.paths, entries: shownEntries },
      };
      if (cwdText) r.cwd = cwdText.text;
      const grants = [
        network ? "network" : undefined,
        ...write.paths.map((x) => `write ${x}`),
        ...read.paths.map((x) => `read ${x}`),
        ...shownEntries.map((e) => `${e.access} ${e.target}`),
      ].filter((x): x is string => x !== undefined);
      return finish(r, [`permissions: ${grants.length ? grants.join("; ") : "(none listed)"}`, r.cwd && `in: ${r.cwd}`]);
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
