// Optional image convenience: verify a native Codex imageGeneration savedPath
// and copy the bytes into an owned UUID subdirectory of CODEX_IMAGE_OUTPUT_ROOT.
//
// A turn that completes with text is NOT image success: success requires a
// native imageGeneration item whose savedPath is a regular PNG/JPEG file under
// the normal Codex home. Image editing is not exposed (unverified).
//
// TOCTOU caveat: the checks in paths.ts (O_NOFOLLOW, lstat/fstat comparison,
// no symlink components, single link) narrow but cannot fully eliminate races
// with another process running as the same user.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyVerifiedInputImage, PathSecurityError } from "./paths.js";
import { TaskError, type TurnOutcome } from "./session.js";

export type ImageErrorCode = "OUTPUT_ROOT_NOT_CONFIGURED" | "NO_IMAGE_PRODUCED" | "IMAGE_VERIFICATION_FAILED";

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

export function outputRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const r = env.CODEX_IMAGE_OUTPUT_ROOT;
  if (!r || !path.isAbsolute(r) || path.normalize(r) !== r) return null;
  return r;
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
 * subdirectory of `root`. Any verification failure fails the whole collection
 * and removes the owned subdirectory; in-flight filesystem work is always
 * awaited before cleanup.
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
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    hooks.checkpoint?.();
    await fsp.mkdir(dir, { mode: 0o700 });
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

export async function collectImage(
  outcome: TurnOutcome,
  root: string,
  allowedSourceRoots: readonly string[] = [codexHome()],
  hooks: CollectHooks = {},
): Promise<ImageFile[]> {
  const saved = outcome.images.flatMap((i) => (i.savedPath !== null ? [i.savedPath] : []));
  return collectImages(saved, root, allowedSourceRoots, hooks);
}
