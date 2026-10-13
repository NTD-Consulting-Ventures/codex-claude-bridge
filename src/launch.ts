// Shared launch environment for every child this package starts: Codex
// (install check, --version, status, app-server), Claude and npm.
//
// The official npm installs of Codex and Claude are `#!/usr/bin/env node`
// JS launchers reached through a symlink, so they need `node` on PATH. Claude
// Desktop often starts MCP servers without the installer's Node directory on
// PATH. The executable itself is always spawned directly (validated
// path/symlink entry, no shell, args unchanged); only the child's PATH is
// prefixed with the directory of the current Node (process.execPath), and only
// when that directory's `node` resolves to the very same Node binary. No
// arbitrary script is ever run through Node.

import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type ExecInvalidReason = "empty" | "nul_byte" | "relative" | "not_normalized" | "missing" | "not_file" | "not_executable";
export type ExecCheck = { ok: true; path: string; real: string } | { ok: false; reason: ExecInvalidReason };

export function isAbsoluteNormalized(raw: string): boolean {
  return raw !== "" && !raw.includes("\0") && path.isAbsolute(raw) && path.normalize(raw) === raw && (raw === "/" || !raw.endsWith("/"));
}

/** Absolute normalized path of an existing executable regular file (symlinks followed; the entry path is kept). */
export function checkExecutable(raw: string): ExecCheck {
  if (raw === "") return { ok: false, reason: "empty" };
  if (raw.includes("\0")) return { ok: false, reason: "nul_byte" };
  if (!path.isAbsolute(raw)) return { ok: false, reason: "relative" };
  if (!isAbsoluteNormalized(raw)) return { ok: false, reason: "not_normalized" };
  let real: string;
  try {
    if (!statSync(raw).isFile()) return { ok: false, reason: "not_file" };
    real = realpathSync(raw);
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    accessSync(raw, constants.X_OK);
  } catch {
    return { ok: false, reason: "not_executable" };
  }
  return { ok: true, path: raw, real };
}

export const EXEC_REASON_TEXT: Record<ExecInvalidReason, string> = {
  empty: "is empty",
  nul_byte: "contains a NUL byte",
  relative: "is not an absolute path",
  not_normalized: "is not a normalized absolute path",
  missing: "does not exist",
  not_file: "is not a regular file",
  not_executable: "is not executable",
};

export type LauncherKind = "native" | "node_shebang" | "other_script" | "unknown";

/** The only Node launcher shape recognized: the first line of official npm bin scripts. */
export const NODE_SHEBANG = "#!/usr/bin/env node";
const HEAD_BYTES = 128;
const NATIVE_MAGIC = ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "7f454c46"];

/** Classifies an executable from at most HEAD_BYTES of its (symlink-resolved) content. Diagnostics only. */
export function launcherKind(file: string): LauncherKind {
  let fd: number;
  try {
    if (!statSync(file).isFile()) return "unknown";
    fd = openSync(file, "r");
  } catch {
    return "unknown";
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0));
    if (head.length >= 4 && NATIVE_MAGIC.includes(head.subarray(0, 4).toString("hex"))) return "native";
    if (head.subarray(0, 2).toString("latin1") !== "#!") return "unknown";
    const nl = head.indexOf(0x0a);
    if (nl < 0) return "other_script";
    return head.subarray(0, nl).toString("latin1") === NODE_SHEBANG ? "node_shebang" : "other_script";
  } catch {
    return "unknown";
  } finally {
    closeSync(fd);
  }
}

export interface NodeDir {
  /** process.execPath (absolute). */
  node: string;
  dir: string;
  /** True only when `<dir>/node` resolves to the same file as `node`. */
  verified: boolean;
}

export function currentNodeDir(execPath: string = process.execPath): NodeDir {
  const dir = path.dirname(execPath);
  let verified = false;
  if (isAbsoluteNormalized(execPath)) {
    try {
      verified = realpathSync(path.join(dir, "node")) === realpathSync(execPath);
    } catch {
      verified = false;
    }
  }
  return { node: execPath, dir, verified };
}

/**
 * Child environment: `base` unchanged except PATH, which gets the verified
 * current-Node directory first (duplicates and empty entries dropped). When the
 * directory cannot be verified, `base` is returned as a copy, unchanged.
 */
export function launchEnv(base: NodeJS.ProcessEnv, execPath: string = process.execPath): NodeJS.ProcessEnv {
  const n = currentNodeDir(execPath);
  if (!n.verified) return { ...base };
  const rest = (base.PATH ?? "").split(path.delimiter).filter((d) => d !== "" && d !== n.dir);
  return { ...base, PATH: [n.dir, ...rest].join(path.delimiter) };
}

/** Base environment of every `codex --version` probe (install and status). */
export const VERSION_PROBE_BASE_ENV: NodeJS.ProcessEnv = Object.freeze({ PATH: "/usr/bin:/bin" });

export interface LauncherStatus {
  codex_bin: string | null;
  codex_bin_source: "env" | "default";
  codex_launcher: LauncherKind | "missing" | "invalid";
  node_path: string;
  node_version: string;
  /** Whether children get this Node's directory first on PATH (needed by npm JS launchers). */
  node_dir_on_child_path: boolean;
}

export function launcherStatus(bin: { path: string | null; source: "env" | "default" }, execPath: string = process.execPath): LauncherStatus {
  let kind: LauncherStatus["codex_launcher"];
  if (bin.path === null) kind = "invalid";
  else if (!checkExecutable(bin.path).ok) kind = "missing";
  else kind = launcherKind(bin.path);
  return {
    codex_bin: bin.path,
    codex_bin_source: bin.source,
    codex_launcher: kind,
    node_path: execPath,
    node_version: process.version,
    node_dir_on_child_path: currentNodeDir(execPath).verified,
  };
}
