// Image saving: verify native Codex imageGeneration savedPaths and copy the
// bytes into an owned UUID subdirectory of the resolved output root
// (src/output-root.ts; default ~/codex-images).
//
// A turn that completes with text is NOT image success: success requires a
// native imageGeneration item whose savedPath is a regular PNG/JPEG file under
// the normal Codex home. Any reported image item that is missing, unsupported
// or unverifiable fails the job; none is silently dropped. Only native
// savedPaths are read, never caller-supplied paths. Image editing is not
// exposed (unverified).
//
// TOCTOU caveat: the checks in paths.ts (O_NOFOLLOW, lstat/fstat comparison,
// no symlink components, single link) narrow but cannot fully eliminate races
// with another process running as the same user.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyVerifiedInputImage, PathSecurityError, prepareOwnedRoot } from "./paths.js";
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

export function buildImagePrompt(prompt: string): string {
  return (
    "Generate exactly one image with your native image generation tool for the description below. " +
    "Do not run shell commands, edit files or call other tools.\n\nDescription:\n" +
    prompt
  );
}

export interface ImageFile {
  path: string;
  mime_type: "image/png" | "image/jpeg";
  bytes: number;
  sha256: string;
}

/** Result contract of a succeeded image job. */
export interface ImageResult {
  job_id: string;
  files: ImageFile[];
  codex_version: string | null;
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
      files.push({ path: img.path, mime_type: img.type === "png" ? "image/png" : "image/jpeg", bytes: img.bytes.length, sha256: img.sha256 });
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
