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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { requireBridgeMode, resolveBridgeMode, type BridgeMode } from "./bridge-mode.js";
import type { CodexTransport } from "./codex-client.js";
import { CwdError, validateCwd } from "./cwd.js";
import { buildImagePrompt, codexHome, collectImage, ImageError, type CollectHooks, type ImageFile, type ImageResult } from "./image-service.js";
import { DEFAULT_WALL_MS, JobManager, MAX_WALL_MS, throwIfAborted, type JobView } from "./jobs.js";
import { resolveOutputRoot, type OutputRootResolution } from "./output-root.js";
import { resolveCodexBin, spawnAppServer, terminateAllAppServers } from "./process-transport.js";
import { runDelegatedTurn, TaskError, type TurnOutcome } from "./session.js";
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
      "{job_id, files:[{path, mime_type, bytes, sha256}], codex_version}. Same cwd-bounded workspace-write policy " +
      "as codex_task_start. May consume quota; never retried.",
    inputSchema: promptCwd,
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
}

function ok(obj: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj };
}

function err(code: string, message: string): ToolResult {
  const obj = { error: { code, message } };
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: true };
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

  /** Throws BridgeModeError (static message) when CODEX_BRIDGE_MODE is set but invalid. */
  constructor(private readonly deps: ServerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.#mode = requireBridgeMode(this.env);
    this.outputRoot = resolveOutputRoot(this.env);
    this.jobs = new JobManager(deps.wallMs ?? wallFromEnv(this.env));
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
        return ok({ ...s, bridge_mode: this.#mode, active_job_id: active !== undefined && this.visibleJob(active) ? active : null });
      }
      case "codex_task_start":
      case "codex_image_generate":
        return this.start(name, args);
      case "codex_task_status": {
        const a = exactKeys(args, ["job_id"]);
        if (!a || typeof a.job_id !== "string") return err("INVALID_ARGUMENTS", "Expected {job_id}.");
        const v = this.visibleJob(a.job_id);
        return v ? ok({ ...v }) : err("UNKNOWN_JOB", "No such job.");
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
    if (this.jobs.active !== undefined) return err("BUSY", "Another job is active.");
    const prompt = name === "codex_image_generate" ? buildImagePrompt(a.prompt) : a.prompt;
    const view = this.jobs.start(name === "codex_image_generate" ? "image" : "task", async (signal, timeoutMs, jobId, own) => {
      const outcome = await runDelegatedTurn({
        prompt,
        cwd,
        timeoutMs,
        signal,
        createTransport: this.createTransport,
        clientVersion: SERVER_VERSION,
      });
      // Post-processing stays inside the job deadline/cancellation: every
      // await completes (no abandoned writes), the signal is checked between
      // awaits, and the owned output dir is removed by JobManager on failure.
      const checkpoint = (): void => throwIfAborted(signal);
      const collect = async (o: TurnOutcome): Promise<ImageFile[]> => {
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
      };
      if (name === "codex_task_start") {
        const noImages = outcome.images.length === 0 && !outcome.imagesOverflow;
        const files = noImages ? [] : await collect(outcome);
        return { text: outcome.text, text_truncated: outcome.textTruncated, image_items: outcome.images.length, files };
      }
      const files = await collect(outcome);
      const version = await codexVersion(this.deps.versionProbe ?? versionProbeFor(this.env));
      checkpoint();
      const result: ImageResult = { job_id: jobId, files, codex_version: version };
      return result;
    });
    if (!view) return err("BUSY", "Another job is active.");
    return ok({ job_id: view.job_id, state: view.state });
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
  installShutdownHandlers(makeShutdown(handler.jobs), {
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
