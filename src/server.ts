#!/usr/bin/env node
// Trusted-local Codex delegation MCP server (stdio).
//
// Tools: codex_status, codex_task_start, codex_task_status, codex_task_cancel
// and codex_image_generate. Native images are copied into the output root
// resolved once by src/output-root.ts (default ~/codex-images); an invalid
// explicit CODEX_IMAGE_OUTPUT_ROOT makes job starts fail with
// OUTPUT_ROOT_INVALID before any job begins. The output root is written by
// this process only; it is never added to Codex's writable roots.
// Inputs are strictly validated; the only free-form value forwarded to Codex
// is the delegated prompt. No model/config/URL/shell parameters exist.
//
// CODEX_BRIDGE_MODE (src/bridge-mode.ts) is resolved once per ToolHandler.
// "image-only" lists only codex_status, codex_image_generate, codex_task_status
// and codex_task_cancel; codex_task_start is refused with TOOL_DISABLED before
// any validation, and jobs of kind "task" are reported as UNKNOWN_JOB. This
// narrows the MCP tool surface only; the Codex launch policy is unchanged.
//
// Image sessions (docs/image-sessions.md): codex_image_generate returns a
// bridge-issued opaque session_handle when the installed app-server schema
// proves continuity support (src/protocol-capabilities.ts). Only an explicit
// handle continues the bridge-owned native thread; no handle (or
// fresh_session) always means a new thread. MCP stdio cannot identify the
// originating Claude conversation, so nothing is inferred.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { requireBridgeMode, resolveBridgeMode, type BridgeMode } from "./bridge-mode.js";
import type { CodexTransport } from "./codex-client.js";
import { CwdError, validateCwd } from "./cwd.js";
import {
  buildImagePrompt,
  codexHome,
  collectImage,
  IMAGE_DEVELOPER_INSTRUCTIONS,
  IMAGE_THREAD_NAME,
  ImageError,
  type CollectHooks,
  type ImageFile,
  type ImageResult,
} from "./image-service.js";
import {
  ImageSessionStore,
  isSessionHandleShape,
  SESSION_HANDLE_PATTERN,
  SESSION_LIMITS,
  type ImageSession,
  type SessionContext,
  type SessionReject,
} from "./image-sessions.js";
import { DEFAULT_WALL_MS, JobManager, MAX_WALL_MS, throwIfAborted, type JobView } from "./jobs.js";
import { resolveOutputRoot, type OutputRootResolution } from "./output-root.js";
import { resolveCodexBin, spawnAppServer, terminateAllAppServers } from "./process-transport.js";
import { discoverImageCapabilities, unavailable, type ImageProtocolCapabilities } from "./protocol-capabilities.js";
import { APPROVAL_POLICY, APPROVALS_REVIEWER, runDelegatedTurn, SANDBOX_MODE, TaskError, type ImageThreadOptions, type TurnOutcome } from "./session.js";
import { codexVersion, getStatus, SERVER_VERSION, versionProbeFor, type CapabilityProbe, type VersionProbe } from "./status.js";
import { launcherStatus } from "./launch.js";

export const MAX_PROMPT_CHARS = 32_000;

const noArgs = { type: "object" as const, properties: {}, additionalProperties: false };
const promptCwd = {
  type: "object" as const,
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_CHARS },
    cwd: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description: "Absolute canonical existing directory (no symlinks, not / or home or its ancestors). The only writable root.",
    },
  },
  required: ["prompt", "cwd"],
  additionalProperties: false,
};
const imageInput = {
  type: "object" as const,
  properties: {
    ...promptCwd.properties,
    session_handle: {
      type: "string",
      pattern: SESSION_HANDLE_PATTERN,
      description:
        "Optional. A session_handle previously returned by this tool. Pass it ONLY when the prompt is an edit of that " +
        "same image; omit it for any unrelated image.",
    },
    fresh_session: {
      type: "boolean",
      description:
        "Optional. true starts a new image thread (revoking the given session_handle, if any). A handle this server " +
        "process never issued is still rejected (SESSION_UNKNOWN); omit it instead.",
    },
  },
  required: ["prompt", "cwd"],
  additionalProperties: false,
};
const jobId = {
  type: "object" as const,
  properties: { job_id: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
  required: ["job_id"],
  additionalProperties: false,
};

export const TOOLS = {
  codex_status: {
    name: "codex_status",
    description: "Codex CLI version, launch policy and a safe summary of installed plugin / MCP server names.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  codex_task_start: {
    name: "codex_task_start",
    description:
      "Start a delegated Codex task on a NEW thread in the given cwd (trusted-local; not a security boundary). " +
      "Runs with native sandbox workspace-write bounded to cwd (only writable root; no network; /tmp and $TMPDIR " +
      "excluded) and approvals on-request: Codex may create and modify files inside cwd without approval. Any " +
      "elevated approval request (outside-root write, network, escalation) fails the job with APPROVAL_REQUIRED. " +
      "One active job at a time. Returns a job_id; poll codex_task_status. Succeeded result: {text, text_truncated, " +
      "image_items, files:[{path, mime_type, bytes, sha256}]}; files holds every verified native generated image " +
      "copied into the image output root (empty when none). An unverifiable image item fails the job.",
    inputSchema: promptCwd,
    // Conservative: delegated Codex runs with the user's normal config/plugins/MCP servers.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  codex_task_status: {
    name: "codex_task_status",
    description: "Get state and (when finished) result or typed error of a job. Result text is Codex output and may contain sensitive data.",
    inputSchema: jobId,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  codex_task_cancel: {
    name: "codex_task_cancel",
    description: "Cancel a running job: interrupts the turn and terminates the Codex process. Not retried.",
    inputSchema: jobId,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  codex_image_generate: {
    name: "codex_image_generate",
    description:
      "Start a job asking Codex to generate one image natively. Success only if a native imageGeneration item " +
      "yields a verified PNG/JPEG, copied into a UUID subdirectory of the image output root (default ~/codex-images; " +
      "see codex_status image_output). Succeeded result: " +
      "{job_id, files:[{path, mime_type, bytes, sha256}], codex_version, session_handle, session}. Same cwd-bounded " +
      "workspace-write policy as codex_task_start. May consume quota; never retried. " +
      "Sessions: when supported, start and result return an opaque session_handle. To refine THAT image, call again " +
      "with the same session_handle, the same cwd, and only the requested change as prompt; the same native Codex " +
      "thread continues. For an unrelated image, omit session_handle. Never reuse a handle across unrelated requests " +
      "or guess one. Handles live in this server process only (lost on restart), expire after 30 min idle, 8 turns " +
      "or 128000 prompt chars, and are revoked by any failure, cancel or timeout. A handle is a bearer capability for " +
      "this server process and cwd, not tied to a Claude conversation: never share it across conversations. A SESSION_* " +
      "error returned by this call rejects THIS request before any new turn; an earlier failed, cancelled or timed-out " +
      "job of the session may still have consumed quota or produced a native image. Never retry automatically; starting " +
      "over with fresh_session: true and a self-contained description is the user's explicit choice. Image job status " +
      "includes session.next_action.",
    inputSchema: imageInput,
    // Conservative: writes files and the image prompt constraint is not enforced natively.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
};

type ToolName = keyof typeof TOOLS;

/** Tools listed (and callable) per bridge mode, in listing order. */
export const MODE_TOOLS: Readonly<Record<BridgeMode, readonly ToolName[]>> = Object.freeze({
  general: Object.freeze(["codex_status", "codex_task_start", "codex_task_status", "codex_task_cancel", "codex_image_generate"] as const),
  "image-only": Object.freeze(["codex_status", "codex_image_generate", "codex_task_status", "codex_task_cancel"] as const),
});

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

export interface ToolResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ServerDeps {
  versionProbe?: VersionProbe;
  capabilityProbe?: CapabilityProbe;
  /** Receives the validated task cwd; fixtures may ignore it. */
  createTransport?: (cwd: string) => CodexTransport;
  wallMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Internal (tests only): awaited after each image output filesystem step has completed. */
  imageAfterStep?: CollectHooks["afterStep"];
  /**
   * Image protocol capabilities of the configured launcher. Default: schema
   * discovery via that launcher; with an injected transport (fixtures) there
   * is no launcher to ask, so continuity is unavailable unless injected here.
   * `signal` aborts on handler shutdown; an injected function must then settle.
   */
  imageCapabilities?: (launcher: string | null, signal: AbortSignal) => Promise<ImageProtocolCapabilities>;
  /** Internal (tests only): clock of the image session store. */
  now?: () => number;
}

/** Launch policy a session was created under; a change makes it incompatible. */
const POLICY_KEY = `${APPROVAL_POLICY}|${APPROVALS_REVIEWER}|${SANDBOX_MODE}|cwd-only|no-network`;
const MAX_JOB_SESSIONS = 64;

const NO_AUTO_RETRY =
  " Do not retry automatically; starting over with fresh_session: true and a self-contained description is the user's explicit choice.";

const SESSION_MESSAGES: Record<SessionReject["code"], string> = {
  SESSION_UNKNOWN:
    "session_handle was not issued by this bridge process (handles do not survive a restart). This request was rejected " +
    "before any turn. fresh_session: true with this handle is rejected too: omit session_handle and send a self-contained " +
    "description if the user wants a new image.",
  SESSION_EXPIRED:
    "This image session expired (idle timeout or evicted) and its edit context is gone. This request was rejected before " +
    "any turn." + NO_AUTO_RETRY,
  SESSION_INVALIDATED:
    "This image session was invalidated by an earlier failed, cancelled, timed-out or reset job. This request was rejected " +
    "before any new turn, but that earlier job may already have consumed quota or produced a native image." + NO_AUTO_RETRY,
  SESSION_ROLLOVER_REQUIRED:
    "This image session reached its turn or prompt-size limit. This request was rejected before any new turn." + NO_AUTO_RETRY,
  SESSION_INCOMPATIBLE:
    "This image session was created with a different cwd, output root, Codex launcher, bridge mode or policy. This request " +
    "was rejected before any new turn. Use the original cwd, or:" + NO_AUTO_RETRY,
};

function sessionErr(r: SessionReject): ToolResult {
  const action = r.code === "SESSION_UNKNOWN" ? "omit_session_handle" : "fresh_session_required";
  const obj = { error: { code: r.code, message: SESSION_MESSAGES[r.code], detail: r.detail, action } };
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: true };
}

/** Like exactKeys, but `optional` keys may be absent. */
function pickKeys(args: unknown, required: string[], optional: string[]): Record<string, unknown> | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const k = Object.keys(a);
  if (!required.every((x) => k.includes(x)) || !k.every((x) => required.includes(x) || optional.includes(x))) return null;
  return a;
}

function ok(obj: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj };
}

function err(code: string, message: string): ToolResult {
  const obj = { error: { code, message } };
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: true };
}

function shuttingDown(): ToolResult {
  return err("SHUTTING_DOWN", "The bridge is shutting down; no job was started.");
}

function disabled(name: ToolName, mode: BridgeMode): ToolResult {
  return err("TOOL_DISABLED", `${name} is not available in ${mode} bridge mode (CODEX_BRIDGE_MODE).`);
}

function exactKeys(args: unknown, keys: string[]): Record<string, unknown> | null {
  if (args === undefined || args === null) return keys.length === 0 ? {} : null;
  if (typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const k = Object.keys(a);
  if (k.length !== keys.length || !k.every((x) => keys.includes(x))) return null;
  return a;
}

export function wallFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.CODEX_TASK_WALL_SECONDS;
  if (raw === undefined) return DEFAULT_WALL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_WALL_MS;
  return Math.min(n * 1000, MAX_WALL_MS);
}

export class ToolHandler {
  readonly jobs: JobManager;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createTransport: (cwd: string) => CodexTransport;
  /** Resolved once so status, listing and every job use the same root. */
  readonly outputRoot: OutputRootResolution;
  /** Resolved once from CODEX_BRIDGE_MODE; fixed for the handler's lifetime (getter only). */
  readonly #mode: BridgeMode;
  /** Image sessions of this handler only; never shared, never persisted. */
  readonly sessions: ImageSessionStore;
  /** Discovered capabilities per configured launcher, for this handler's lifetime. */
  private readonly caps = new Map<string, Promise<ImageProtocolCapabilities>>();
  private lastCaps: ImageProtocolCapabilities | undefined;
  /** Discoveries not yet settled (reaped and cleaned up); shutdown waits for them. */
  private readonly pendingCaps = new Set<Promise<unknown>>();
  /** Aborted once by shutdown(): no job starts afterwards and schema discovery is killed. */
  private readonly lifecycle = new AbortController();
  private shutdownDone: Promise<void> | undefined;
  /** Image job id -> session handle, for polling metadata (bounded). */
  private readonly jobSessions = new Map<string, string>();

  /** Throws BridgeModeError (static message) when CODEX_BRIDGE_MODE is set but invalid. */
  constructor(private readonly deps: ServerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.#mode = requireBridgeMode(this.env);
    this.outputRoot = resolveOutputRoot(this.env);
    this.jobs = new JobManager(deps.wallMs ?? wallFromEnv(this.env));
    this.sessions = new ImageSessionStore(deps.now);
    this.createTransport =
      deps.createTransport ??
      ((cwd) => {
        const bin = resolveCodexBin(this.env).path;
        if (bin === null) throw new Error("CODEX_BIN invalid");
        return spawnAppServer({ bin, cwd });
      });
  }

  get mode(): BridgeMode {
    return this.#mode;
  }

  get closing(): boolean {
    return this.lifecycle.signal.aborted;
  }

  /**
   * Idempotent. Synchronously refuses new starts and aborts pending schema
   * discovery, then cancels the active job and terminates owned app-servers
   * (as makeShutdown), and resolves only once every discovery generator has
   * been reaped and its temp dir removed.
   */
  shutdown(terminateAll: () => Promise<void> = terminateAllAppServers, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    this.lifecycle.abort();
    return (this.shutdownDone ??= (async () => {
      try {
        await makeShutdown(this.jobs, terminateAll, graceMs)();
      } finally {
        await Promise.allSettled([...this.pendingCaps]);
      }
    })());
  }

  private exposed(name: ToolName): boolean {
    return MODE_TOOLS[this.#mode].includes(name);
  }

  /** In image-only mode only image jobs are visible; others are reported as unknown. */
  private visibleJob(id: string): JobView | undefined {
    const v = this.jobs.get(id);
    return v && (this.#mode === "general" || v.kind === "image") ? v : undefined;
  }

  /** Mode-dependent; an invalid output root is reported by codex_status and job starts, never hidden. */
  listTools(): (typeof TOOLS)[ToolName][] {
    return MODE_TOOLS[this.#mode].map((n) => TOOLS[n]);
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    // Before any argument, output-root or cwd validation and before any job exists.
    if (!isToolName(name)) return err("UNKNOWN_TOOL", "Unknown tool.");
    if (!this.exposed(name)) return disabled(name, this.#mode);
    switch (name) {
      case "codex_status": {
        if (!exactKeys(args, [])) return err("INVALID_ARGUMENTS", "codex_status accepts no arguments.");
        const s = await getStatus(
          this.deps.versionProbe ?? versionProbeFor(this.env),
          this.deps.capabilityProbe,
          this.outputRoot,
          launcherStatus(resolveCodexBin(this.env)),
        );
        const active = this.jobs.active;
        return ok({
          ...s,
          bridge_mode: this.#mode,
          active_job_id: active !== undefined && this.visibleJob(active) ? active : null,
          image_sessions: {
            // Discovered on the first image job; "unknown" until then.
            continuity: this.lastCaps === undefined ? "unknown" : this.lastCaps.continuity ? "available" : "unavailable",
            retained: this.sessions.size,
            max_sessions: SESSION_LIMITS.maxSessions,
            idle_ttl_seconds: SESSION_LIMITS.idleTtlMs / 1000,
            max_turns: SESSION_LIMITS.maxTurns,
            max_prompt_chars: SESSION_LIMITS.maxPromptChars,
          },
        });
      }
      case "codex_task_start":
        return this.start(name, args);
      case "codex_image_generate":
        return this.startImage(args);
      case "codex_task_status": {
        const a = exactKeys(args, ["job_id"]);
        if (!a || typeof a.job_id !== "string") return err("INVALID_ARGUMENTS", "Expected {job_id}.");
        const v = this.visibleJob(a.job_id);
        if (!v) return err("UNKNOWN_JOB", "No such job.");
        const handle = this.jobSessions.get(v.job_id);
        if (handle === undefined) return ok({ ...v });
        const st = this.sessions.state(handle);
        const next = v.state === "running" ? "wait" : st.usable ? "reuse_only_for_related_edits" : "fresh_session_required";
        return ok({ ...v, session: { session_handle: handle, usable: st.usable, revoked_reason: st.reason, rollover_reason: st.rollover, next_action: next } });
      }
      case "codex_task_cancel": {
        const a = exactKeys(args, ["job_id"]);
        if (!a || typeof a.job_id !== "string") return err("INVALID_ARGUMENTS", "Expected {job_id}.");
        const v = this.visibleJob(a.job_id);
        if (!v) return err("UNKNOWN_JOB", "No such job.");
        const cancelled = this.jobs.cancel(a.job_id);
        return ok({ job_id: a.job_id, cancel_requested: cancelled, state: v.state });
      }
      default:
        return err("UNKNOWN_TOOL", "Unknown tool.");
    }
  }

  private async start(name: "codex_task_start" | "codex_image_generate", args: unknown): Promise<ToolResult> {
    // Re-checked here so no runtime caller can start a hidden or unknown kind.
    if (name !== "codex_task_start" && name !== "codex_image_generate") return err("UNKNOWN_TOOL", "Unknown tool.");
    if (!this.exposed(name)) return disabled(name, this.#mode);
    if (name === "codex_image_generate") return this.startImage(args);
    const a = exactKeys(args, ["prompt", "cwd"]);
    if (!a || typeof a.prompt !== "string" || a.prompt.trim().length === 0 || a.prompt.length > MAX_PROMPT_CHARS) {
      return err("INVALID_ARGUMENTS", `Expected {prompt (1..${MAX_PROMPT_CHARS} chars), cwd}.`);
    }
    // Both tools may save images; an invalid root fails before any job begins.
    if (!this.outputRoot.ok) return err("OUTPUT_ROOT_INVALID", this.outputRoot.message);
    const root = this.outputRoot.path;
    let cwd: string;
    try {
      cwd = await validateCwd(a.cwd);
    } catch (e) {
      return err("INVALID_CWD", e instanceof CwdError ? e.message : "cwd rejected");
    }
    if (this.closing) return shuttingDown();
    if (this.jobs.active !== undefined) return err("BUSY", "Another job is active.");
    const prompt = a.prompt;
    const view = this.jobs.start("task", async (signal, timeoutMs, _jobId, own) => {
      const outcome = await runDelegatedTurn({
        prompt,
        cwd,
        timeoutMs,
        signal,
        createTransport: this.createTransport,
        clientVersion: SERVER_VERSION,
      });
      const noImages = outcome.images.length === 0 && !outcome.imagesOverflow;
      const files = noImages ? [] : await this.collect(outcome, root, signal, own);
      return { text: outcome.text, text_truncated: outcome.textTruncated, image_items: outcome.images.length, files };
    });
    if (!view) return err("BUSY", "Another job is active.");
    return ok({ job_id: view.job_id, state: view.state });
  }

  /**
   * Post-processing stays inside the job deadline/cancellation: every await
   * completes (no abandoned writes), the signal is checked between awaits, and
   * the owned output dir is removed by JobManager on failure.
   */
  private async collect(o: TurnOutcome, root: string, signal: AbortSignal, own: (c: () => Promise<void>) => void): Promise<ImageFile[]> {
    const checkpoint = (): void => throwIfAborted(signal);
    checkpoint();
    let files: ImageFile[];
    try {
      files = await collectImage(o, root, [codexHome(this.env)], { checkpoint, own, afterStep: this.deps.imageAfterStep });
    } catch (e) {
      if (e instanceof ImageError) throw new TaskError(e.code);
      throw e;
    }
    checkpoint();
    return files;
  }

  /**
   * Capabilities of the configured launcher, discovered once per handler
   * (failures fail closed). Shutdown aborts the discovery; a cancelled result
   * is neither cached nor reported, and the caller re-checks `closing`.
   */
  private imageCapabilities(launcher: string | null): Promise<ImageProtocolCapabilities> {
    const key = launcher ?? "";
    let p = this.caps.get(key);
    if (!p) {
      const signal = this.lifecycle.signal;
      const discover =
        this.deps.imageCapabilities ??
        (this.deps.createTransport
          ? async () => unavailable("injected_transport")
          : (bin: string | null) => discoverImageCapabilities(bin, { env: this.env, signal }));
      const run: Promise<ImageProtocolCapabilities> = discover(launcher, signal)
        .catch(() => unavailable("discovery_failed"))
        .then((c) => {
          if (signal.aborted || c.reason === "discovery_cancelled") {
            if (this.caps.get(key) === run) this.caps.delete(key);
            return unavailable("discovery_cancelled");
          }
          return (this.lastCaps = c);
        })
        .finally(() => this.pendingCaps.delete(run));
      p = run;
      this.pendingCaps.add(run);
      if (this.caps.size >= 4) this.caps.clear();
      this.caps.set(key, p);
    }
    // The caller is released as soon as shutdown begins, even if the discovery is still being reaped.
    const signal = this.lifecycle.signal;
    if (signal.aborted) return Promise.resolve(unavailable("discovery_cancelled"));
    return new Promise((resolve) => {
      const onAbort = (): void => resolve(unavailable("discovery_cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then((c) => {
        signal.removeEventListener("abort", onAbort);
        resolve(c);
      });
    });
  }

  private async startImage(args: unknown): Promise<ToolResult> {
    if (!this.exposed("codex_image_generate")) return disabled("codex_image_generate", this.#mode);
    const a = pickKeys(args, ["prompt", "cwd"], ["session_handle", "fresh_session"]);
    if (
      !a ||
      typeof a.prompt !== "string" ||
      a.prompt.trim().length === 0 ||
      a.prompt.length > MAX_PROMPT_CHARS ||
      (a.fresh_session !== undefined && typeof a.fresh_session !== "boolean")
    ) {
      return err("INVALID_ARGUMENTS", `Expected {prompt (1..${MAX_PROMPT_CHARS} chars), cwd, session_handle?, fresh_session?}.`);
    }
    // Only bridge-issued handles; a native thread id or any other string is never accepted.
    if (a.session_handle !== undefined && !isSessionHandleShape(a.session_handle)) {
      return err("INVALID_ARGUMENTS", "session_handle must be a handle returned by codex_image_generate; native thread ids are not accepted.");
    }
    const handle = a.session_handle as string | undefined;
    const fresh = a.fresh_session === true;
    const userPrompt = a.prompt;
    if (!this.outputRoot.ok) return err("OUTPUT_ROOT_INVALID", this.outputRoot.message);
    const root = this.outputRoot.path;
    let cwd: string;
    try {
      cwd = await validateCwd(a.cwd);
    } catch (e) {
      return err("INVALID_CWD", e instanceof CwdError ? e.message : "cwd rejected");
    }
    // BUSY and SHUTTING_DOWN never consume, revoke or reset a handle: both are checked before any session change.
    if (this.closing) return shuttingDown();
    if (this.jobs.active !== undefined) return err("BUSY", "Another job is active.");
    const launcher = resolveCodexBin(this.env).path;
    const caps = await this.imageCapabilities(launcher);
    // A discovery cancelled by shutdown never falls back to a generation.
    if (this.closing || caps.reason === "discovery_cancelled") return shuttingDown();
    if (this.jobs.active !== undefined) return err("BUSY", "Another job is active.");

    const ctx: SessionContext = { cwd, mode: this.#mode, outputRoot: root, launcher: launcher ?? "", policy: POLICY_KEY };
    let session: ImageSession | undefined;
    let continued = false;
    if (handle !== undefined) {
      if (!this.sessions.owns(handle)) return sessionErr({ code: "SESSION_UNKNOWN", detail: null });
      if (fresh) {
        this.sessions.revoke(handle, "reset");
      } else {
        const c = this.sessions.check(handle, ctx, userPrompt.length);
        if (!("handle" in c)) return sessionErr(c);
        session = c;
        continued = true;
      }
    }
    if (!session && caps.continuity) session = this.sessions.create(ctx);

    // Native developer instructions keep the single-image guidance out of the
    // visible user message; without them the prompt wrapper is the fallback.
    const prompt = caps.nativeInstructions ? userPrompt : buildImagePrompt(userPrompt);
    let native: { threadId: string; model: string } | undefined;
    let jobIdSeen: string | undefined;
    const image: ImageThreadOptions | undefined = caps.nativeInstructions
      ? {
          developerInstructions: IMAGE_DEVELOPER_INSTRUCTIONS,
          threadName: caps.setName && !continued ? IMAGE_THREAD_NAME : null,
          excludeTurns: caps.resumeExcludeTurns,
          onThread: (threadId, model) => void (native = { threadId, model }),
        }
      : undefined;
    if (image && continued && session) image.resume = { threadId: session.threadId!, model: session.model! };
    const sessionMeta = (jobId: string): Pick<ImageResult, "session_handle" | "session"> =>
      session
        ? { session_handle: session.handle, session: { ...this.sessions.view(session, { promptChars: userPrompt.length, jobId }, continued) } }
        : { session_handle: null, session: { continuity: "unavailable", reason: caps.reason } };

    if (session) this.sessions.lease(session);
    const view = this.jobs.start(
      "image",
      async (signal, timeoutMs, jobId, own) => {
        jobIdSeen = jobId;
        const outcome = await runDelegatedTurn({
          prompt,
          cwd,
          timeoutMs,
          signal,
          createTransport: this.createTransport,
          clientVersion: SERVER_VERSION,
          // Every image job, including the prompt-wrapper fallback, reads only its own thread+turn.
          strictImageEvents: true,
          ...(image ? { image } : {}),
        });
        const files = await this.collect(outcome, root, signal, own);
        const version = await codexVersion(this.deps.versionProbe ?? versionProbeFor(this.env));
        throwIfAborted(signal);
        const result: ImageResult = { job_id: jobId, files, codex_version: version, ...sessionMeta(jobId) };
        return result;
      },
      (state) => {
        if (!session) return;
        // Only a fully succeeded job (turn, verification, output, version) advances the session.
        if (state === "succeeded" && native && jobIdSeen) this.sessions.succeed(session, native.threadId, native.model, userPrompt.length, jobIdSeen);
        else this.sessions.fail(session);
      },
    );
    if (!view) {
      if (session) this.sessions.release(session);
      return err("BUSY", "Another job is active.");
    }
    if (session) {
      this.jobSessions.set(view.job_id, session.handle);
      while (this.jobSessions.size > MAX_JOB_SESSIONS) this.jobSessions.delete(this.jobSessions.keys().next().value!);
    }
    return ok({ job_id: view.job_id, state: view.state, ...sessionMeta(view.job_id) });
  }
}

export function buildServer(deps: ServerDeps = {}): { server: Server; handler: ToolHandler } {
  const handler = new ToolHandler(deps);
  const server = new Server({ name: "codex-claude-bridge", version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: handler.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handler.call(req.params.name, req.params.arguments);
    } catch {
      return err("INTERNAL", "Internal error.");
    }
  });
  return { server, handler };
}

export function createServer(deps: ServerDeps = {}): Server {
  return buildServer(deps).server;
}

export const SHUTDOWN_GRACE_MS = 3_000;

/**
 * Returns an idempotent shutdown: cancels the active job (turn interrupt +
 * process-group termination, waiting up to `graceMs`), then terminates every
 * app-server process group this process still owns.
 */
export function makeShutdown(
  jobs: JobManager,
  terminateAll: () => Promise<void> = terminateAllAppServers,
  graceMs = SHUTDOWN_GRACE_MS,
): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () =>
    (done ??= (async () => {
      try {
        await jobs.shutdown(graceMs);
      } finally {
        await terminateAll();
      }
    })());
}

export interface ShutdownHooks {
  server: Pick<Server, "onclose">;
  proc: Pick<NodeJS.Process, "once">;
  stdin: Pick<NodeJS.ReadableStream, "once">;
  exit: (code: number) => void;
}

/** Runs `shutdown` once on MCP close, stdin EOF, SIGINT or SIGTERM, then exits. */
export function installShutdownHandlers(shutdown: () => Promise<void>, hooks: ShutdownHooks): void {
  let exiting = false;
  const stop = (code: number): void => {
    if (exiting) return;
    exiting = true;
    void shutdown()
      .catch(() => undefined)
      .finally(() => hooks.exit(code));
  };
  const prev = hooks.server.onclose;
  hooks.server.onclose = () => {
    prev?.();
    stop(0);
  };
  hooks.stdin.once("end", () => stop(0));
  hooks.stdin.once("close", () => stop(0));
  hooks.proc.once("SIGINT", () => stop(130));
  hooks.proc.once("SIGTERM", () => stop(143));
}

/** Exit status when CODEX_BRIDGE_MODE is invalid: nothing was started. */
export const EXIT_INVALID_BRIDGE_MODE = 2;

async function main(): Promise<void> {
  // Validated before any transport exists; the diagnostic is static (the value is never echoed).
  const mode = resolveBridgeMode(process.env);
  if (!mode.ok) {
    process.stderr.write(`codex-claude-bridge: ${mode.message}; not starting.\n`);
    process.exit(EXIT_INVALID_BRIDGE_MODE);
  }
  const { server, handler } = buildServer();
  installShutdownHandlers(() => handler.shutdown(), {
    server,
    proc: process,
    stdin: process.stdin,
    exit: (code) => process.exit(code),
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("codex-claude-bridge: failed to start\n");
    process.exit(1);
  });
}
