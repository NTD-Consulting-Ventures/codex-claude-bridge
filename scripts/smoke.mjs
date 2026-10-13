#!/usr/bin/env node
// Parent-controlled LIVE smoke test. Not run by `npm test`.
//
//   node scripts/smoke.mjs status
//   node scripts/smoke.mjs task
//   node scripts/smoke.mjs image --confirm-spend-one-image
//
// Starts the built MCP server over stdio with the official MCP SDK client,
// exactly like Claude Code would. Each run gets its own git-ignored workspace
// at .smoke/<uuid>/ (task cwd = .smoke/<uuid>/workspace, image output root =
// .smoke/<uuid>/images). Evidence (sanitized tool results) is written to
// .smoke/<uuid>/evidence.json. No retries: one tool call per mode.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2];
if (!["status", "task", "image"].includes(mode)) {
  process.stderr.write("usage: smoke.mjs status|task|image [--confirm-spend-one-image]\n");
  process.exit(64);
}
if (mode === "image" && !process.argv.includes("--confirm-spend-one-image")) {
  process.stderr.write("image mode spends one real image generation; pass --confirm-spend-one-image.\n");
  process.exit(64);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runDir = path.join(repo, ".smoke", randomUUID());
const workspace = path.join(runDir, "workspace");
const images = path.join(runDir, "images");
mkdirSync(workspace, { recursive: true, mode: 0o700 });

const TASK_PROMPT =
  "This is a connectivity check. Reply with exactly the single word PONG. " +
  "Do not run any commands, do not read or edit any files, and do not call any tools, plugins or MCP servers.";
const IMAGE_PROMPT = "A small flat-style illustration of a red apple on a white background.";

const env = { ...process.env, CODEX_TASK_WALL_SECONDS: "300" };
if (mode === "image") env.CODEX_IMAGE_OUTPUT_ROOT = images;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repo, "dist", "src", "server.js")],
  env,
  stderr: "ignore",
});
const client = new Client({ name: "codex-image-mcp-smoke", version: "0" });
const evidence = { mode, started_at: new Date().toISOString(), steps: [] };
const record = (step, data) => evidence.steps.push({ step, at: new Date().toISOString(), data });

async function poll(jobId) {
  const deadline = Date.now() + 660_000;
  for (;;) {
    const r = await client.callTool({ name: "codex_task_status", arguments: { job_id: jobId } });
    if (r.structuredContent?.state !== "running" || Date.now() > deadline) return r.structuredContent;
    await new Promise((res) => setTimeout(res, 2_000));
  }
}

let exitCode = 0;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  record("list_tools", tools.map((t) => t.name));
  if (mode === "status") {
    record("codex_status", (await client.callTool({ name: "codex_status", arguments: {} })).structuredContent);
  } else {
    const tool = mode === "task" ? "codex_task_start" : "codex_image_generate";
    const prompt = mode === "task" ? TASK_PROMPT : IMAGE_PROMPT;
    const started = await client.callTool({ name: tool, arguments: { prompt, cwd: workspace } });
    record(tool, started.structuredContent);
    const jobId = started.structuredContent?.job_id;
    if (typeof jobId !== "string") {
      exitCode = 1;
    } else {
      const final = await poll(jobId);
      record("final", final);
      if (final?.state !== "succeeded") exitCode = 1;
    }
  }
} catch {
  record("error", "smoke client error");
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  evidence.finished_at = new Date().toISOString();
  evidence.exit_code = exitCode;
  writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`evidence: ${path.relative(repo, path.join(runDir, "evidence.json"))} (exit ${exitCode})\n`);
}
process.exit(exitCode);
