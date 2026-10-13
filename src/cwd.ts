import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export class CwdError extends Error {
  constructor(readonly reason: string) {
    super(`cwd rejected: ${reason}`);
    this.name = "CwdError";
  }
}

/** True if `dir` is `/`, the home directory, or an ancestor of it (a writable root there would cover home). */
function tooBroad(dir: string): boolean {
  if (dir === path.parse(dir).root) return true;
  const rel = path.relative(dir, os.homedir());
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Synchronous shape check (no filesystem access): absolute, normalized, no
 * trailing separator, and neither "/" nor the home directory nor an ancestor
 * of it. Used again when building the policy params, as defense in depth.
 */
export function assertCwdShape(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096 || cwd.includes("\0")) {
    throw new CwdError("invalid");
  }
  if (!path.isAbsolute(cwd)) throw new CwdError("must be absolute");
  const norm = path.normalize(cwd).replace(/(.)\/+$/, "$1");
  if (norm !== cwd) throw new CwdError("must be normalized");
  if (tooBroad(cwd)) throw new CwdError("too broad");
  return cwd;
}

/**
 * Explicit task cwd: absolute, normalized, an existing directory reached
 * without symlinks (canonical), and neither "/" nor the home directory nor an
 * ancestor of it. It becomes the only writable root of the delegated turn.
 * Validation happens at start time only (TOCTOU: the directory can change later).
 */
export async function validateCwd(cwd: unknown): Promise<string> {
  assertCwdShape(cwd);
  const p = cwd as string;
  let real: string;
  try {
    real = await fsp.realpath(p);
  } catch {
    throw new CwdError("does not exist");
  }
  if (real !== p) throw new CwdError("must not traverse symlinks");
  const st = await fsp.stat(real);
  if (!st.isDirectory()) throw new CwdError("not a directory");
  return real;
}
