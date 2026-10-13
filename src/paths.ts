// Security path validation for image inputs and owned outputs.
//
// PREPARATORY ONLY. Not exposed through any MCP tool.

import { createHash, randomUUID } from "node:crypto";
import { constants as FS, promises as fsp, type Stats } from "node:fs";
import path from "node:path";

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export type ImageType = "png" | "jpeg";

export class PathSecurityError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Path rejected: ${reason}`);
    this.name = "PathSecurityError";
    this.reason = reason;
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= PNG_SIG.length && buf.subarray(0, PNG_SIG.length).equals(PNG_SIG)) return "png";
  if (
    buf.length >= 4 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff &&
    buf[buf.length - 2] === 0xff &&
    buf[buf.length - 1] === 0xd9
  ) {
    return "jpeg";
  }
  return null;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Requires absolute, normalized roots. Returns them unchanged. */
export function normalizeRoots(roots: readonly string[]): string[] {
  if (roots.length === 0) throw new PathSecurityError("no allowed roots configured");
  return roots.map((r) => {
    if (typeof r !== "string" || !path.isAbsolute(r)) throw new PathSecurityError("root must be absolute");
    if (path.normalize(r) !== r.replace(/\/+$/, "") && path.normalize(r) !== r) {
      throw new PathSecurityError("root must be normalized");
    }
    return path.normalize(r).replace(/(.)\/+$/, "$1");
  });
}

function findRoot(candidate: string, roots: string[]): string {
  for (const root of roots) {
    const rel = path.relative(root, candidate);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return root;
  }
  throw new PathSecurityError("outside allowed roots");
}

/** lstat every component from "/" to target; reject any symlink. */
async function assertNoSymlinkComponents(target: string): Promise<Stats> {
  const parts = target.split(path.sep).filter(Boolean);
  let cur: string = path.sep;
  let st = await fsp.lstat(cur);
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      st = await fsp.lstat(cur);
    } catch {
      throw new PathSecurityError("path component missing");
    }
    if (st.isSymbolicLink()) throw new PathSecurityError("symlink in path");
  }
  return st;
}

export interface VerifiedImage {
  path: string;
  type: ImageType;
  sha256: string;
  bytes: Buffer;
}

/**
 * Validates and reads a regular PNG/JPEG file inside one of the explicit roots.
 * Uses O_NOFOLLOW and compares lstat before / fstat during / lstat after.
 */
export async function readVerifiedInputImage(
  inputPath: string,
  allowedRoots: readonly string[],
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<VerifiedImage> {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) throw new PathSecurityError("invalid path");
  if (!path.isAbsolute(inputPath)) throw new PathSecurityError("path must be absolute");
  const normalized = path.normalize(inputPath);
  if (normalized !== inputPath) throw new PathSecurityError("path must be normalized");
  const roots = normalizeRoots(allowedRoots);
  findRoot(normalized, roots);

  const before = await assertNoSymlinkComponents(normalized);
  if (!before.isFile()) throw new PathSecurityError("not a regular file");
  if (before.size > maxBytes) throw new PathSecurityError("file too large");
  if (before.nlink > 1) throw new PathSecurityError("hard-linked file");

  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(normalized, FS.O_RDONLY | FS.O_NOFOLLOW | (FS.O_NONBLOCK ?? 0));
  } catch {
    throw new PathSecurityError("open failed");
  }
  let bytes: Buffer;
  try {
    const during = await fh.stat();
    if (!during.isFile() || !sameFile(before, during)) throw new PathSecurityError("file changed during open");
    bytes = Buffer.alloc(during.size);
    let off = 0;
    while (off < bytes.length) {
      const { bytesRead } = await fh.read(bytes, off, bytes.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    if (off !== bytes.length) throw new PathSecurityError("file changed during read");
    const extra = Buffer.alloc(1);
    const { bytesRead: tail } = await fh.read(extra, 0, 1, off);
    if (tail !== 0) throw new PathSecurityError("file changed during read");
    const duringAfter = await fh.stat();
    if (!sameFile(during, duringAfter)) throw new PathSecurityError("file changed during read");
  } finally {
    await fh.close();
  }
  const after = await assertNoSymlinkComponents(normalized);
  if (!sameFile(before, after)) throw new PathSecurityError("file replaced after read");

  const type = detectImageType(bytes);
  if (!type) throw new PathSecurityError("not a PNG or JPEG image");
  return { path: normalized, type, sha256: sha256(bytes), bytes };
}

/** Copies a verified input into destDir under a fresh UUID name (O_EXCL, O_NOFOLLOW, 0600). */
export async function copyVerifiedInputImage(
  inputPath: string,
  allowedRoots: readonly string[],
  destDir: string,
): Promise<VerifiedImage> {
  const img = await readVerifiedInputImage(inputPath, allowedRoots);
  const dest = await writeExclusive(destDir, img.type, img.bytes);
  return { ...img, path: dest };
}

async function assertOwnedDir(dir: string): Promise<void> {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new PathSecurityError("output dir must be absolute and normalized");
  const st = await assertNoSymlinkComponents(dir);
  if (!st.isDirectory()) throw new PathSecurityError("output dir is not a directory");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new PathSecurityError("output dir not owned by current user");
  }
}

/**
 * Prepares the image output root before anything is written: every existing
 * component from "/" must be a real directory (no symlinks) BEFORE the root is
 * created, and the final root must be an owned, symlink-free directory.
 * Missing components are created 0700 only after that pre-check.
 */
export async function prepareOwnedRoot(root: string): Promise<void> {
  if (typeof root !== "string" || root.includes("\0") || !path.isAbsolute(root) || path.normalize(root) !== root || root === path.sep) {
    throw new PathSecurityError("output root must be absolute, normalized and not /");
  }
  let cur: string = path.sep;
  for (const part of root.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st: Stats;
    try {
      st = await fsp.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new PathSecurityError("output root not accessible");
    }
    if (st.isSymbolicLink()) throw new PathSecurityError("symlink in path");
    if (!st.isDirectory()) throw new PathSecurityError("output root component is not a directory");
  }
  try {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  } catch {
    throw new PathSecurityError("output root could not be created");
  }
  await assertOwnedDir(root);
}

async function writeExclusive(dir: string, type: ImageType, bytes: Buffer): Promise<string> {
  await assertOwnedDir(dir);
  const dest = path.join(dir, `${randomUUID()}.${type === "png" ? "png" : "jpg"}`);
  const fh = await fsp.open(dest, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(bytes);
  } finally {
    await fh.close();
  }
  return dest;
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg)$/;

export interface OutputReservation {
  dir: string;
  id: string;
  path: string;
}

/** Reserves a UUID-named output path in an owned directory. Nothing is created. */
export async function reserveOutput(dir: string, type: ImageType): Promise<OutputReservation> {
  await assertOwnedDir(dir);
  const id = randomUUID();
  return { dir, id, path: path.join(dir, `${id}.${type === "png" ? "png" : "jpg"}`) };
}

/**
 * Verifies that an output file is the one we reserved: UUID name, regular file,
 * no symlinks, owned by us, valid image signature, and (if given) matching hash.
 */
export async function verifyOwnedOutput(
  reservation: OutputReservation,
  expectedSha256?: string,
): Promise<VerifiedImage> {
  const name = path.basename(reservation.path);
  if (!UUID_NAME.test(name) || !name.startsWith(reservation.id) || path.dirname(reservation.path) !== reservation.dir) {
    throw new PathSecurityError("output name not owned");
  }
  await assertOwnedDir(reservation.dir);
  const st = await assertNoSymlinkComponents(reservation.path);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new PathSecurityError("output not owned by current user");
  }
  const img = await readVerifiedInputImage(reservation.path, [reservation.dir]);
  if (expectedSha256 !== undefined && img.sha256 !== expectedSha256) throw new PathSecurityError("output hash mismatch");
  return img;
}
