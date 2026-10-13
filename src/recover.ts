// Read-only recovery of an image that Codex already generated and saved for an
// OWNED thread (one this project created), e.g. when the MCP job itself failed
// after generation. Never starts a thread or turn and never retries.
//
// Protocol: initialize -> initialized -> thread/read {threadId, includeTurns:true}.
// Nothing else is sent. A native imageGeneration item's savedPath is used when
// thread/read returns one. If thread/read is unavailable, no savedPath is
// invented: the fallback only looks inside generated_images/<threadId>/ under
// the normal Codex home and labels the match "metadata_correlated".

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { CodexClientError, CodexRpcClient, type CodexTransport } from "./codex-client.js";
import { collectImages, type ImageFile } from "./image-service.js";
import { initializeParams } from "./session.js";
import { listingFailureReason } from "./status.js";

const RPC_TIMEOUT_MS = 30_000;
const MAX_ITEMS_SCANNED = 10_000;
const MAX_FALLBACK_ENTRIES = 64;
export const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RecoverySource = "native_saved_path" | "metadata_correlated";

export interface RecoveredFile extends ImageFile {
  source: RecoverySource;
  /** sha256 of the copy re-read from disk equals the copy-time hash. */
  copy_rehash_match: boolean;
  /** PNG/JPEG magic bytes of the copy, re-checked from disk. */
  signature: "png" | "jpeg" | null;
  /** sha256 of the decoded inline `result` equals the file; null when no inline result was returned. */
  inline_result_match: boolean | null;
  source_mtime: string;
}

export interface RecoveryEvidence {
  thread_id: string;
  methods_sent: string[];
  thread_read: { ok: boolean; reason: string | null; image_items: number; saved_paths: number };
  files: RecoveredFile[];
  recovered: boolean;
  note: string;
}

export interface RecoverOptions {
  threadId: string;
  createTransport: () => CodexTransport;
  codexHome: string;
  outputRoot: string;
  clientVersion: string;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

interface NativeImage {
  savedPath: string;
  inlineSha256: string | null;
}

/** Native imageGeneration items of thread.turns[].items[] whose thread id matches. */
export function nativeImages(result: unknown, threadId: string): { items: number; images: NativeImage[] } {
  const thread = obj(obj(result)?.thread);
  if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) throw new Error("shape");
  let scanned = 0;
  let items = 0;
  const images: NativeImage[] = [];
  for (const t of thread.turns) {
    const list = obj(t)?.items;
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      if (++scanned > MAX_ITEMS_SCANNED) throw new Error("bounds");
      const o = obj(it);
      if (o?.type !== "imageGeneration") continue;
      items++;
      if (typeof o.savedPath !== "string" || !path.isAbsolute(o.savedPath)) continue;
      const inline = typeof o.result === "string" && o.result.length > 0 ? Buffer.from(o.result, "base64") : null;
      images.push({ savedPath: o.savedPath, inlineSha256: inline ? createHash("sha256").update(inline).digest("hex") : null });
    }
  }
  return { items, images };
}

function signatureOf(b: Buffer): "png" | "jpeg" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

async function verifyCopies(files: ImageFile[], sources: string[], inline: (string | null)[], source: RecoverySource): Promise<RecoveredFile[]> {
  const out: RecoveredFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const bytes = await fsp.readFile(f.path);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const st = await fsp.lstat(sources[i]!);
    const want = inline[i] ?? null;
    out.push({
      ...f,
      source,
      copy_rehash_match: sha === f.sha256 && bytes.length === f.bytes,
      signature: signatureOf(bytes),
      inline_result_match: want === null ? null : want === f.sha256,
      source_mtime: st.mtime.toISOString(),
    });
  }
  return out;
}

/** Regular PNG/JPEG-named files directly inside generated_images/<threadId>/ (no recursion, no symlinks). */
async function correlatedPaths(codexHome: string, threadId: string): Promise<string[]> {
  const dir = path.join(codexHome, "generated_images", threadId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.(png|jpe?g)$/i.test(e.name))
    .slice(0, MAX_FALLBACK_ENTRIES)
    .map((e) => path.join(dir, e.name))
    .sort();
}

export async function recoverOwnedImage(opts: RecoverOptions): Promise<RecoveryEvidence> {
  if (!THREAD_ID_RE.test(opts.threadId)) throw new Error("invalid thread id");
  const methods: string[] = [];
  const ev: RecoveryEvidence = {
    thread_id: opts.threadId,
    methods_sent: methods,
    thread_read: { ok: false, reason: null, image_items: 0, saved_paths: 0 },
    files: [],
    recovered: false,
    note: "",
  };
  let native: NativeImage[] = [];
  const client = new CodexRpcClient(opts.createTransport());
  try {
    methods.push("initialize");
    await client.request("initialize", initializeParams(opts.clientVersion), { timeoutMs: RPC_TIMEOUT_MS });
    methods.push("initialized");
    client.notify("initialized");
    methods.push("thread/read");
    const r = nativeImages(
      await client.request("thread/read", { threadId: opts.threadId, includeTurns: true }, { timeoutMs: RPC_TIMEOUT_MS }),
      opts.threadId,
    );
    native = r.images;
    ev.thread_read = { ok: true, reason: null, image_items: r.items, saved_paths: r.images.length };
  } catch (e) {
    const method = methods.at(-1) === "thread/read" ? "thread/read" : "initialize";
    ev.thread_read.reason = e instanceof CodexClientError ? listingFailureReason(method, e) : `${method} failed: invalid_response_shape`;
  } finally {
    client.kill("closed");
  }

  if (native.length > 0) {
    const sources = native.map((n) => n.savedPath);
    const files = await collectImages(sources, opts.outputRoot, [opts.codexHome]);
    ev.files = await verifyCopies(files, sources, native.map((n) => n.inlineSha256), "native_saved_path");
    ev.note = "Recovered from native imageGeneration savedPath returned by thread/read.";
  } else {
    const sources = await correlatedPaths(opts.codexHome, opts.threadId);
    if (sources.length > 0) {
      const files = await collectImages(sources, opts.outputRoot, [opts.codexHome]);
      ev.files = await verifyCopies(files, sources, sources.map(() => null), "metadata_correlated");
      ev.note = ev.thread_read.ok
        ? "thread/read returned no imageGeneration savedPath; file correlated only by generated_images/<thread_id>/ location."
        : "thread/read unavailable; file correlated only by generated_images/<thread_id>/ location, not by a native savedPath event.";
    } else {
      ev.note = "No image found for this thread.";
    }
  }
  ev.recovered = ev.files.length > 0 && ev.files.every((f) => f.copy_rehash_match && f.signature !== null);
  return ev;
}
