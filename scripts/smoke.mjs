#!/usr/bin/env node
// Parent-controlled LIVE smoke test. Not run by `npm test`.
//
//   node scripts/smoke.mjs status
//   node scripts/smoke.mjs task
//   node scripts/smoke.mjs write
//   node scripts/smoke.mjs image --confirm-spend-one-image
//
// Starts the built MCP server over stdio with the official MCP SDK client,
// exactly like Claude Code would. Each run gets its own git-ignored workspace
// at .smoke/<uuid>/ (task cwd = .smoke/<uuid>/workspace, image output root =
// .smoke/<uuid>/images). Evidence (sanitized tool results) is written to
// .smoke/<uuid>/evidence.json. No retries: one tool call per job.
//
// write: two sequential codex_task_start jobs (each a new thread/process):
// create, then modify, one file inside the workspace. After each job the file
// bytes must equal the expected UTF-8 text plus exactly one LF (Buffer
// equality, no normalization), and a sentinel file next to (outside) the
// workspace must stay byte-identical. The observed bytes after each step are
// kept as .smoke/<uuid>/receipt-<step>.txt; evidence.json records only
// booleans, sizes and sha256 values. This SDK-client smoke is a supplement; it
// does not replace a test driven through Claude Code itself.

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2];
if (!["status", "task", "write", "image"].includes(mode)) {
  process.stderr.write("usage: smoke.mjs status|task|write|image [--confirm-spend-one-image]\n");
  process.exit(64);
}
if (mode === "image" && !process.argv.includes("--confirm-spend-one-image")) {
  process.stderr.write("image mode spends one real image generation; pass --confirm-spend-one-image.\n");
  process.exit(64);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(path.join(repo, ".smoke"), { recursive: true, mode: 0o700 });
// Canonical (symlink-free) paths: the server rejects any cwd that is not.
const runDir = path.join(realpathSync(path.join(repo, ".smoke")), randomUUID());
const workspace = path.join(runDir, "workspace");
const images = path.join(runDir, "images");
mkdirSync(workspace, { recursive: true, mode: 0o700 });

const TASK_PROMPT =
  "This is a connectivity check. Reply with exactly the single word PONG. " +
  "Do not run any commands, do not read or edit any files, and do not call any tools, plugins or MCP servers.";
const IMAGE_PROMPT = "A small flat-style illustration of a red apple on a white background.";
const WRITE_FILE = "codex-write-test.txt";
const WRITE_STEPS = [
  {
    name: "create",
    expected: Buffer.from("created by codex\n", "utf8"),
    prompt:
      `In the current working directory ${workspace} create a new file named ${WRITE_FILE} containing exactly ` +
      "the UTF-8 text: created by codex, followed by one LF newline and nothing else. Do not create, modify or " +
      "delete anything else, do not use the network, and do not call plugins or MCP servers. Then reply DONE.",
  },
  {
    name: "modify",
    expected: Buffer.from("modified by codex\n", "utf8"),
    prompt:
      `In the current working directory ${workspace} replace the entire contents of the existing file ${WRITE_FILE} ` +
      "with exactly the UTF-8 text: modified by codex, followed by one LF newline and nothing else. Do not create, " +
      "modify or delete anything else, do not use the network, and do not call plugins or MCP servers. Then reply DONE.",
  },
];
const SENTINEL = path.join(runDir, "outside-sentinel.txt");
const SENTINEL_BYTES = Buffer.from("outside the writable root; must stay unchanged\n", "utf8");
const readOrNull = (p) => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};
const sha256 = (b) => (b === null ? null : createHash("sha256").update(b).digest("hex"));

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
  } else if (mode === "write") {
    writeFileSync(SENTINEL, SENTINEL_BYTES, { mode: 0o600 });
    for (const s of WRITE_STEPS) {
      const started = await client.callTool({ name: "codex_task_start", arguments: { prompt: s.prompt, cwd: workspace } });
      record(`codex_task_start:${s.name}`, started.structuredContent);
      const jobId = started.structuredContent?.job_id;
      if (typeof jobId !== "string") {
        exitCode = 1;
        break;
      }
      const final = await poll(jobId);
      record(`final:${s.name}`, final);
      const bytes = readOrNull(path.join(workspace, WRITE_FILE));
      // Exact snapshot of what is on disk after this step (outside the workspace).
      if (bytes !== null) writeFileSync(path.join(runDir, `receipt-${s.name}.txt`), bytes, { mode: 0o600 });
      const sentinel = readOrNull(SENTINEL);
      const check = {
        file_exists: bytes !== null,
        bytes_exact: bytes !== null && bytes.equals(s.expected),
        bytes: bytes?.length ?? null,
        sha256: sha256(bytes),
        expected_sha256: sha256(s.expected),
        sentinel_unchanged: sentinel !== null && sentinel.equals(SENTINEL_BYTES),
      };
      record(`verify:${s.name}`, check);
      if (final?.state !== "succeeded" || !check.bytes_exact || !check.sentinel_unchanged) {
        exitCode = 1;
        break;
      }
    }
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
