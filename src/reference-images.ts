// Caller-supplied reference images for codex_image_generate / codex_task_start.
//
// Each entry is a path relative to the job's cwd (or absolute inside it). It
// must resolve inside cwd without symlink components and be a regular,
// single-link PNG/JPEG within the size bounds; the file is read once here to
// check its signature (src/paths.ts readVerifiedInputImage: O_NOFOLLOW,
// lstat/fstat comparison). Valid entries are handed to Codex only as
// `localImage` turn inputs (absolute paths); Codex reads them itself. They are
// never copied, written or returned as outputs. Rejections name the entry's
// index and a fixed reason, never file contents.
//
// TOCTOU caveat: like cwd, the files are checked at start time; another
// process running as the same user can change them before Codex reads them.

import path from "node:path";
import { PathSecurityError, readVerifiedInputImage } from "./paths.js";

export const MAX_REFERENCE_IMAGES = 8;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PATH_CHARS = 4096;

export type ReferenceRejectReason =
  | "invalid_path"
  | "outside_cwd"
  | "not_found"
  | "symlink"
  | "not_a_file"
  | "hard_linked"
  | "too_large"
  | "total_too_large"
  | "not_png_or_jpeg"
  | "changed_while_reading"
  | "duplicate";

export class ReferenceImageError extends Error {
  constructor(
    readonly index: number,
    readonly reason: ReferenceRejectReason,
  ) {
    super(`reference_images[${index}] rejected: ${reason}`);
    this.name = "ReferenceImageError";
  }
}

const REASONS: [RegExp, ReferenceRejectReason][] = [
  [/outside allowed roots/, "outside_cwd"],
  [/path component missing/, "not_found"],
  [/symlink/, "symlink"],
  [/not a regular file/, "not_a_file"],
  [/hard-linked/, "hard_linked"],
  [/too large/, "too_large"],
  [/not a PNG or JPEG/, "not_png_or_jpeg"],
  [/changed|replaced|open failed/, "changed_while_reading"],
];

function reasonOf(e: unknown): ReferenceRejectReason {
  if (!(e instanceof PathSecurityError)) return "changed_while_reading";
  for (const [re, r] of REASONS) if (re.test(e.reason)) return r;
  return "invalid_path";
}

/** Shape check for the tool argument (no filesystem access). */
export function isReferenceList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= MAX_REFERENCE_IMAGES && v.every((x) => typeof x === "string");
}

/**
 * Resolves and verifies every entry against the validated canonical cwd.
 * Returns absolute paths in the given order; throws ReferenceImageError.
 */
export async function validateReferenceImages(list: readonly string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  let total = 0;
  for (const [i, raw] of list.entries()) {
    if (raw.length === 0 || raw.length > MAX_PATH_CHARS || raw.includes("\0")) throw new ReferenceImageError(i, "invalid_path");
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.join(cwd, raw);
    const rel = path.relative(cwd, abs);
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new ReferenceImageError(i, "outside_cwd");
    if (out.includes(abs)) throw new ReferenceImageError(i, "duplicate");
    let bytes: number;
    try {
      bytes = (await readVerifiedInputImage(abs, [cwd], MAX_REFERENCE_IMAGE_BYTES)).bytes.length;
    } catch (e) {
      throw new ReferenceImageError(i, reasonOf(e));
    }
    total += bytes;
    if (total > MAX_REFERENCE_TOTAL_BYTES) throw new ReferenceImageError(i, "total_too_large");
    out.push(abs);
  }
  return out;
}
