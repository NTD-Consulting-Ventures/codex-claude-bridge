import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export class CwdError extends Error {
  constructor(readonly reason: string) {
    super(`cwd rejected: ${reason}`);
    this.name = "CwdError";
  }
}

/**
 * Explicit task cwd: absolute, normalized, an existing directory reached
 * without symlinks, and neither "/" nor the home directory itself.
 * Validation happens at start time only (TOCTOU: the directory can change later).
 */
export async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096 || cwd.includes("\0")) {
    throw new CwdError("invalid");
  }
  if (!path.isAbsolute(cwd)) throw new CwdError("must be absolute");
  const norm = path.normalize(cwd).replace(/(.)\/+$/, "$1");
  if (norm !== cwd) throw new CwdError("must be normalized");
  let real: string;
  try {
    real = await fsp.realpath(cwd);
  } catch {
    throw new CwdError("does not exist");
  }
  if (real !== cwd) throw new CwdError("must not traverse symlinks");
  const st = await fsp.stat(real);
  if (!st.isDirectory()) throw new CwdError("not a directory");
  if (real === path.parse(real).root || real === os.homedir()) throw new CwdError("too broad");
  return real;
}
