// Image saving: verify native Codex imageGeneration savedPaths and copy the
// bytes into an owned UUID subdirectory of the resolved output root
// (src/output-root.ts; default ~/codex-images).
//
// A turn that completes with text is NOT image success: success requires a
// native imageGeneration item whose savedPath is a regular PNG/JPEG file under
// the normal Codex home. Any reported image item that is missing, unsupported
// or unverifiable fails the job; none is silently dropped. Only native
// savedPaths are read as outputs, never caller-supplied paths (caller
// reference images are validated separately, src/reference-images.ts, and
// only handed to Codex as turn input).
//
// Saving is incremental (ImageSink): each completed native image is verified
// and copied as soon as Codex reports it, so a running job can already list
// files_so_far. When a job fails, times out or is cancelled, every verified
// copy is kept and reported as partial_files, and completed images that were
// not copied yet are salvaged after the failure (not during shutdown). Only
// files that did not verify, or were not completely written, are removed.
//
// TOCTOU caveat: the checks in paths.ts (O_NOFOLLOW, lstat/fstat comparison,
// no symlink components, single link) narrow but cannot fully eliminate races
// with another process running as the same user.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyVerifiedInputImage, PathSecurityError, prepareOwnedRoot, type VerifiedImage } from "./paths.js";
import { TaskError, type TurnOutcome } from "./session.js";

export type ImageErrorCode =
  | "OUTPUT_ROOT_INVALID"
  | "OUTPUT_ROOT_UNAVAILABLE"
  | "NO_IMAGE_PRODUCED"
  | "IMAGE_ITEM_INVALID"
  | "IMAGE_VERIFICATION_FAILED";

export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode) {
    super(code);
    this.name = "ImageError";
  }
}

/** The normal Codex home (path only; nothing inside it is read except the saved image). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.CODEX_HOME;
  return h && path.isAbsolute(h) ? path.normalize(h) : path.join(os.homedir(), ".codex");
}

/** Prompt-wrapper fallback, used only when the schema has no thread/start developerInstructions. */
export function buildImagePrompt(prompt: string, hasReferences = false): string {
  return (
    "Generate exactly one image with your native image generation tool for the description below. " +
    (hasReferences ? "The attached images are visual references for it. " : "") +
    "Do not run shell commands, edit files or call other tools.\n\nDescription:\n" +
    prompt
  );
}

/** Fixed output-format phrases for the optional `aspect` argument of codex_image_generate. */
export const ASPECTS = {
  "1:1": "square, aspect ratio 1:1",
  "4:3": "landscape, aspect ratio 4:3",
  "3:2": "landscape, aspect ratio 3:2",
  "16:9": "wide landscape, aspect ratio 16:9",
  "2:1": "wide landscape, aspect ratio 2:1",
  "3:4": "portrait, aspect ratio 3:4",
  "2:3": "portrait, aspect ratio 2:3",
  "9:16": "tall portrait, aspect ratio 9:16",
  "1:2": "tall portrait, aspect ratio 1:2",
} as const;
export type Aspect = keyof typeof ASPECTS;

export function isAspect(v: unknown): v is Aspect {
  return typeof v === "string" && Object.hasOwn(ASPECTS, v);
}

/** Appends the fixed output-format line. The native tool still picks the final pixel size; check width/height. */
export function withAspect(prompt: string, aspect: Aspect | undefined): string {
  return aspect === undefined ? prompt : `${prompt}\n\nOutput format: ${ASPECTS[aspect]}.`;
}

/**
 * Native developer instructions of every bridge-owned image thread (sent on
 * thread/start and reapplied on thread/resume), so the visible user message is
 * the caller's own image request or edit.
 */
export const IMAGE_DEVELOPER_INSTRUCTIONS =
  "This thread serves image requests relayed by codex-claude-bridge. For each user message, generate exactly one " +
  "image with your native image generation tool. When a message asks for a change, apply it to the most recent " +
  "image generated in this thread and keep everything else consistent. Images attached to a user message are " +
  "visual references for that request (for example characters, props or an earlier version to edit); use them as " +
  "references for the new image. Do not run shell commands, edit files or call other tools.";

/** Fixed native thread name (no user content). */
export const IMAGE_THREAD_NAME = "codex-claude-bridge image session";

export interface ImageFile {
  path: string;
  mime_type: "image/png" | "image/jpeg";
  bytes: number;
  sha256: string;
  /** Order in which Codex reported the image within its job (0-based). */
  index: number;
  /** Pixel size read from the PNG/JPEG header; null when it could not be read. */
  width: number | null;
  height: number | null;
  /** PNG with an alpha channel or tRNS chunk; false for JPEG; null when unknown. */
  has_alpha: boolean | null;
  /** Only on partial files found by location (generated_images/<thread>/) rather than a native image event. */
  source?: "thread_folder";
}

/** Width, height and alpha from a PNG IHDR / JPEG SOF header (bounded scan; null when unreadable). */
export function imageInfo(bytes: Buffer, type: "png" | "jpeg"): { width: number | null; height: number | null; has_alpha: boolean | null } {
  const none = { width: null, height: null, has_alpha: null };
  try {
    if (type === "png") {
      if (bytes.length < 33 || bytes.toString("latin1", 12, 16) !== "IHDR") return none;
      const colorType = bytes[25]!;
      let alpha = colorType === 4 || colorType === 6;
      // A tRNS chunk before the image data also means transparency.
      for (let off = 8, n = 0; !alpha && off + 8 <= bytes.length && n < 64; n++) {
        const len = bytes.readUInt32BE(off);
        const kind = bytes.toString("latin1", off + 4, off + 8);
        if (kind === "tRNS") alpha = true;
        if (kind === "IDAT" || kind === "IEND") break;
        off += 12 + len;
      }
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), has_alpha: alpha };
    }
    let off = 2;
    for (let n = 0; off + 4 <= bytes.length && n < 512; n++) {
      if (bytes[off] !== 0xff) return none;
      const marker = bytes[off + 1]!;
      if (marker === 0xff) {
        off++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = bytes.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (off + 9 > bytes.length) return none;
        return { width: bytes.readUInt16BE(off + 7), height: bytes.readUInt16BE(off + 5), has_alpha: false };
      }
      off += 2 + len;
    }
    return none;
  } catch {
    return none;
  }
}

function fileOf(img: VerifiedImage, dest: string, index: number): ImageFile {
  return {
    path: dest,
    mime_type: img.type === "png" ? "image/png" : "image/jpeg",
    bytes: img.bytes.length,
    sha256: img.sha256,
    index,
    ...imageInfo(img.bytes, img.type),
  };
}

/** Result contract of a succeeded image job. */
export interface ImageResult {
  job_id: string;
  files: ImageFile[];
  codex_version: string | null;
  /** Bridge-issued opaque handle for related edits (src/image-sessions.ts); null when continuity is unavailable. */
  session_handle: string | null;
  session: Record<string, unknown>;
}

/** Internal job hooks: cancellation, owned-output registration and a test-only after-step gate. */
export interface CollectHooks {
  /** Checked between awaits; throwing aborts collection (the owned dir is then removed). */
  checkpoint?: () => void;
  /** Receives cleanup for the owned UUID dir as soon as it exists. */
  own?: (cleanup: () => Promise<void>) => void;
  /**
   * Tests only: awaited AFTER each filesystem step has already completed; it
   * does not hold the step's own IO in flight.
   */
  afterStep?: ((step: "mkdir" | "copy") => Promise<void>) | undefined;
}

/** Removes only the owned UUID dir created by this collection. */
function removeOwned(dir: string): () => Promise<void> {
  return () => fsp.rm(dir, { recursive: true, force: true });
}

/**
 * Verifies every native imageGeneration savedPath (sequentially, at most
 * MAX_IMAGE_ITEMS from session.ts) and copies each into one owned UUID
 * subdirectory of `root`. The root is validated (no symlink components,
 * owned directory) before anything is created in it. Any verification failure
 * fails the whole collection and removes the owned subdirectory; in-flight
 * filesystem work is always awaited before cleanup.
 */
export async function collectImages(
  savedPaths: readonly string[],
  root: string,
  allowedSourceRoots: readonly string[] = [codexHome()],
  hooks: CollectHooks = {},
): Promise<ImageFile[]> {
  if (savedPaths.length === 0) throw new ImageError("NO_IMAGE_PRODUCED");
  hooks.checkpoint?.();
  const dir = path.join(root, randomUUID());
  let created = false;
  try {
    try {
      await prepareOwnedRoot(root);
      hooks.checkpoint?.();
      await fsp.mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if (e instanceof TaskError) throw e;
      throw new ImageError("OUTPUT_ROOT_UNAVAILABLE");
    }
    created = true;
    hooks.own?.(removeOwned(dir));
    await hooks.afterStep?.("mkdir");
    hooks.checkpoint?.();
    const files: ImageFile[] = [];
    for (const p of savedPaths) {
      const img = await copyVerifiedInputImage(p, allowedSourceRoots, dir);
      files.push(fileOf(img, img.path, files.length));
      await hooks.afterStep?.("copy");
      hooks.checkpoint?.();
    }
    return files;
  } catch (e) {
    if (created) await removeOwned(dir)().catch(() => undefined);
    if (e instanceof ImageError) throw e;
    if (e instanceof PathSecurityError) throw new ImageError("IMAGE_VERIFICATION_FAILED");
    // Checkpoint (cancellation/deadline) errors carry their own typed code.
    if (e instanceof TaskError) throw e;
    if (e instanceof Error) throw new ImageError("IMAGE_VERIFICATION_FAILED");
    throw e;
  }
}

/**
 * Native savedPaths of a turn's imageGeneration items, deduplicated. Throws
 * IMAGE_ITEM_INVALID when any item lacks a savedPath, is not completed, or
 * items beyond the session bound were dropped.
 */
export function nativeSavedPaths(outcome: TurnOutcome): string[] {
  if (outcome.imagesOverflow) throw new ImageError("IMAGE_ITEM_INVALID");
  const out: string[] = [];
  for (const i of outcome.images) {
    if (i.savedPath === null || i.status !== "completed") throw new ImageError("IMAGE_ITEM_INVALID");
    if (!out.includes(i.savedPath)) out.push(i.savedPath);
  }
  return out;
}

/** Collects every native image of the turn; fails when there is none. */
export async function collectImage(
  outcome: TurnOutcome,
  root: string,
  allowedSourceRoots: readonly string[] = [codexHome()],
  hooks: CollectHooks = {},
): Promise<ImageFile[]> {
  return collectImages(nativeSavedPaths(outcome), root, allowedSourceRoots, hooks);
}

/** A complete PNG ends with this IEND chunk (length 0, type, CRC). */
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** At most this many images are saved per job (native items plus thread-folder matches). */
export const MAX_SAVED_IMAGES = 8;
const THREAD_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Clock skew tolerated when matching thread-folder files to the turn start. */
const MTIME_SKEW_MS = 2_000;

export interface SinkHooks {
  /** Throws once the job is aborted: further copies are deferred (salvage() may still save them). */
  checkpoint?: () => void;
  /** True once nothing more may be written at all (server shutdown); honoured during salvage too. */
  stop?: () => boolean;
  /** Tests only: awaited AFTER each filesystem step has already completed. */
  afterStep?: CollectHooks["afterStep"];
}

/**
 * Incremental, serialized saving of one job's native images into one owned
 * UUID subdirectory of the output root (created on the first image). Each
 * image is verified (src/paths.ts) and copied once; the order of add() calls
 * is the reported index. Nothing that was verified and completely written is
 * ever removed; finish() removes only unverified or partial leftovers and an
 * empty directory. Every filesystem step is awaited (drain()) before a job
 * is released.
 */
export class ImageSink {
  private dir: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly order: string[] = [];
  private readonly fromFolder = new Set<string>();
  private readonly saved = new Map<string, ImageFile>();
  private readonly deferred: string[] = [];
  private readonly failed = new Set<string>();
  private salvaging = false;
  /** The output root could not be prepared; nothing can be saved. */
  rootUnavailable = false;

  constructor(
    private readonly root: string,
    private readonly allowedSourceRoots: readonly string[] = [codexHome()],
    private readonly hooks: SinkHooks = {},
  ) {}

  /** Queues a native savedPath (deduplicated, bounded). */
  add(savedPath: string): void {
    if (this.order.includes(savedPath) || this.order.length >= MAX_SAVED_IMAGES) return;
    const index = this.order.length;
    this.order.push(savedPath);
    this.chain = this.chain.then(() => this.copy(savedPath, index));
  }

  /** Paths that did not verify. */
  get failures(): number {
    return this.failed.size;
  }

  /** Every verified copy, in index order. */
  files(): ImageFile[] {
    return [...this.saved.values()].sort((a, b) => a.index - b.index);
  }

  /** Waits until every queued step (including ones queued meanwhile) has completed. */
  async drain(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c;
      if (c === this.chain) return;
    }
  }

  /**
   * Copies once more every image whose copy failed: Codex may report an image
   * a moment before its file is complete. Called on success before failures
   * are judged, and by salvage().
   */
  async retryFailed(): Promise<void> {
    await this.drain();
    for (const p of [...this.failed]) {
      this.failed.delete(p);
      const index = this.order.indexOf(p);
      this.chain = this.chain.then(() => this.copy(p, index));
    }
    await this.drain();
  }

  /** After a failure: saves deferred images regardless of the abort and retries failed copies, then drains. */
  async salvage(): Promise<void> {
    await this.drain();
    this.salvaging = true;
    for (const p of this.deferred.splice(0)) {
      const index = this.order.indexOf(p);
      this.chain = this.chain.then(() => this.copy(p, index));
    }
    await this.retryFailed();
  }

  /**
   * After a failure: images Codex saved into generated_images/<threadId>/ at
   * or after the turn start but never reported as a native item (for example
   * when the turn was cut off). Matched by location and time only, so they
   * are labelled source "thread_folder"; duplicates of saved files are dropped.
   */
  async salvageThreadFolder(codexHomeDir: string, threadId: string | null, sinceMs: number | null, skewMs: number = MTIME_SKEW_MS): Promise<void> {
    if (threadId === null || sinceMs === null || !THREAD_DIR_RE.test(threadId) || this.hooks.stop?.()) return;
    const dir = path.join(codexHomeDir, "generated_images", threadId);
    let found: { p: string; mtime: number }[] = [];
    try {
      const st = await fsp.lstat(dir);
      if (!st.isDirectory()) return;
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!e.isFile() || !/\.(png|jpe?g)$/i.test(e.name)) continue;
        const p = path.join(dir, e.name);
        const m = (await fsp.lstat(p)).mtimeMs;
        if (m >= sinceMs - skewMs) found.push({ p, mtime: m });
        if (found.length > 64) break;
      }
    } catch {
      return;
    }
    found = found.sort((a, b) => a.mtime - b.mtime || a.p.localeCompare(b.p));
    this.salvaging = true;
    for (const { p } of found) {
      if (this.order.includes(p) || this.order.length >= MAX_SAVED_IMAGES) continue;
      this.fromFolder.add(p);
      this.add(p);
    }
    await this.drain();
  }

  /** Removes unverified or partial leftovers, and the directory when nothing was saved. */
  async finish(): Promise<void> {
    await this.drain();
    if (this.dir === null) return;
    if (this.saved.size === 0) {
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    const keep = new Set([...this.saved.values()].map((f) => path.basename(f.path)));
    try {
      for (const name of await fsp.readdir(this.dir)) {
        if (!keep.has(name)) await fsp.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {
      // Best effort; saved files are never touched.
    }
  }

  private aborted(): boolean {
    if (this.salvaging) return false;
    try {
      this.hooks.checkpoint?.();
      return false;
    } catch {
      return true;
    }
  }

  private async copy(p: string, index: number): Promise<void> {
    if (this.saved.has(p) || this.failed.has(p) || this.rootUnavailable || this.hooks.stop?.()) return;
    if (this.aborted()) {
      if (!this.deferred.includes(p)) this.deferred.push(p);
      return;
    }
    if (this.dir === null) {
      const dir = path.join(this.root, randomUUID());
      try {
        await prepareOwnedRoot(this.root);
        await fsp.mkdir(dir, { mode: 0o700 });
      } catch {
        this.rootUnavailable = true;
        return;
      }
      this.dir = dir;
      await this.hooks.afterStep?.("mkdir");
      if (this.aborted()) {
        this.deferred.push(p);
        return;
      }
    }
    let img: VerifiedImage;
    try {
      img = await copyVerifiedInputImage(p, this.allowedSourceRoots, this.dir);
    } catch {
      this.failed.add(p);
      return;
    }
    const f = fileOf(img, img.path, index);
    if (this.fromFolder.has(p)) {
      // Matched by location only: it may still be being written, so a PNG must end with its IEND chunk
      // (a JPEG's end marker is already required by the signature check), and duplicates are dropped.
      if ((img.type === "png" && !img.bytes.subarray(-12).equals(PNG_IEND)) || [...this.saved.values()].some((x) => x.sha256 === f.sha256)) {
        await fsp.rm(img.path, { force: true }).catch(() => undefined);
        return;
      }
      f.source = "thread_folder";
    }
    this.saved.set(p, f);
    await this.hooks.afterStep?.("copy");
  }
}
