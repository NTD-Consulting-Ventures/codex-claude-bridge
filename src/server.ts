#!/usr/bin/env node
// Trusted-local Codex delegation MCP server (stdio).
//
// Tools: codex_status, codex_task_start, codex_task_status, codex_task_cancel
// and, when CODEX_IMAGE_OUTPUT_ROOT is configured, codex_image_generate.
// Inputs are strictly validated; the only free-form value forwarded to Codex
// is the delegated prompt. No model/config/URL/shell parameters exist.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import type { CodexTransport } from "./codex-client.js";
import { CwdError, validateCwd } from "./cwd.js";
import { buildImagePrompt, codexHome, collectImage, ImageError, outputRoot, type CollectHooks, type ImageFile, type ImageResult } from "./image-service.js";
import { DEFAULT_WALL_MS, JobManager, MAX_WALL_MS, throwIfAborted } from "./jobs.js";
import { resolveCodexBin, spawnAppServer, terminateAllAppServers } from "./process-transport.js";
import { runDelegatedTurn, TaskError } from "./session.js";
import { codexVersion, getStatus, SERVER_VERSION, type CapabilityProbe, type VersionProbe } from "./status.js";

export const MAX_PROMPT_CHARS = 32_000;

const noArgs = { type: "object" as const, properties: {}, additionalProperties: false };
const promptCwd = {
  type: "object" as const,
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_CHARS },
    cwd: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute existing directory, no symlinks." },
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
      "Runs with native sandbox read-only and approvals on-request; any approval request fails the job with " +
      "APPROVAL_REQUIRED. One active job at a time. Returns a job_id; poll codex_task_status.",
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
      "yields a verified PNG/JPEG, copied into a UUID subdirectory of CODEX_IMAGE_OUTPUT_ROOT. Succeeded result: " +
      "{job_id, files:[{path, mime_type, bytes, sha256}], codex_version}. May consume quota; never retried.",
    inputSchema: promptCwd,
    // Conservative: writes files and the image prompt constraint is not enforced natively.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
};

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

  constructor(private readonly deps: ServerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.jobs = new JobManager(deps.wallMs ?? wallFromEnv(this.env));
    this.createTransport =
      deps.createTransport ??
      ((cwd) => {
        const bin = resolveCodexBin(this.env).path;
        if (bin === null) throw new Error("CODEX_BIN invalid");
        return spawnAppServer({ bin, cwd });
      });
  }

  get imageEnabled(): boolean {
    return outputRoot(this.env) !== null;
  }

  listTools(): (typeof TOOLS)[keyof typeof TOOLS][] {
    const t = [TOOLS.codex_status, TOOLS.codex_task_start, TOOLS.codex_task_status, TOOLS.codex_task_cancel];
    if (this.imageEnabled) t.push(TOOLS.codex_image_generate);
    return t;
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    switch (name) {
      case "codex_status": {
        if (!exactKeys(args, [])) return err("INVALID_ARGUMENTS", "codex_status accepts no arguments.");
        const s = await getStatus(this.deps.versionProbe, this.deps.capabilityProbe, this.imageEnabled);
        return ok({ ...s, active_job_id: this.jobs.active ?? null });
      }
      case "codex_task_start":
      case "codex_image_generate":
        return this.start(name, args);
      case "codex_task_status": {
        const a = exactKeys(args, ["job_id"]);
        if (!a || typeof a.job_id !== "string") return err("INVALID_ARGUMENTS", "Expected {job_id}.");
        const v = this.jobs.get(a.job_id);
        return v ? ok({ ...v }) : err("UNKNOWN_JOB", "No such job.");
      }
      case "codex_task_cancel": {
        const a = exactKeys(args, ["job_id"]);
        if (!a || typeof a.job_id !== "string") return err("INVALID_ARGUMENTS", "Expected {job_id}.");
        const v = this.jobs.get(a.job_id);
        if (!v) return err("UNKNOWN_JOB", "No such job.");
        const cancelled = this.jobs.cancel(a.job_id);
        return ok({ job_id: a.job_id, cancel_requested: cancelled, state: v.state });
      }
      default:
        return err("UNKNOWN_TOOL", "Unknown tool.");
    }
  }

  private async start(name: "codex_task_start" | "codex_image_generate", args: unknown): Promise<ToolResult> {
    const a = exactKeys(args, ["prompt", "cwd"]);
    if (!a || typeof a.prompt !== "string" || a.prompt.trim().length === 0 || a.prompt.length > MAX_PROMPT_CHARS) {
      return err("INVALID_ARGUMENTS", `Expected {prompt (1..${MAX_PROMPT_CHARS} chars), cwd}.`);
    }
    const root = outputRoot(this.env);
    if (name === "codex_image_generate" && root === null) {
      return err("OUTPUT_ROOT_NOT_CONFIGURED", "Set CODEX_IMAGE_OUTPUT_ROOT to an absolute normalized path.");
    }
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
      if (name === "codex_task_start") {
        return { text: outcome.text, text_truncated: outcome.textTruncated, image_items: outcome.images.length };
      }
      // Post-processing stays inside the job deadline/cancellation: every
      // await completes (no abandoned writes), the signal is checked between
      // awaits, and the owned output dir is removed by JobManager on failure.
      const checkpoint = (): void => throwIfAborted(signal);
      checkpoint();
      let files: ImageFile[];
      try {
        files = await collectImage(outcome, root as string, [codexHome(this.env)], { checkpoint, own, afterStep: this.deps.imageAfterStep });
      } catch (e) {
        if (e instanceof ImageError) throw new TaskError(e.code);
        throw e;
      }
      checkpoint();
      const version = await codexVersion(this.deps.versionProbe);
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
  const server = new Server({ name: "codex-image-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} } });
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

async function main(): Promise<void> {
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
    process.stderr.write("codex-image-mcp: failed to start\n");
    process.exit(1);
  });
}
