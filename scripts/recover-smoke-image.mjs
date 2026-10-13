#!/usr/bin/env node
// Parent-controlled, READ-ONLY recovery of the image from the one authorized
// live image smoke whose MCP job failed after Codex had saved the PNG.
//
//   node scripts/recover-smoke-image.mjs thread_id=01a134d0-aebf-7840-8bc2-5d9f9d816c96
//
// Only thread ids created by this project's own smoke runs are accepted
// (OWNED_THREAD_IDS); the user's other sessions are never read. Sends only
// initialize / initialized / thread/read (see src/recover.ts): no thread or
// turn is started, nothing is generated or retried. Reads no Codex config or
// auth itself. The saved image is only read and copied into
// .smoke/recovered-owned/<uuid>/. Evidence goes to
// .smoke/recovered-owned/evidence-<uuid>.json.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNED_THREAD_IDS = new Set(["01a134d0-aebf-7840-8bc2-5d9f9d816c96"]);
const FAILED_JOB_EVIDENCE = ".smoke/028a4f34-d024-4c53-b71b-cb6ff6eef3d5/evidence.json";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repo, "dist", "src");
if (!existsSync(path.join(dist, "recover.js"))) {
  process.stderr.write("Build first (npm run build); dist/src/recover.js not found.\n");
  process.exit(1);
}
const args = process.argv.slice(2);
const threadId = args.length === 1 && args[0].startsWith("thread_id=") ? args[0].slice("thread_id=".length) : null;
if (threadId === null || !OWNED_THREAD_IDS.has(threadId)) {
  process.stderr.write("usage: recover-smoke-image.mjs thread_id=<owned smoke thread id>\n");
  process.exit(64);
}

const { recoverOwnedImage } = await import(path.join(dist, "recover.js"));
const { codexHome } = await import(path.join(dist, "image-service.js"));
const { resolveCodexBin, spawnAppServer } = await import(path.join(dist, "process-transport.js"));
const { codexVersion, SERVER_VERSION } = await import(path.join(dist, "status.js"));

const bin = resolveCodexBin().path;
if (bin === null) {
  process.stderr.write("CODEX_BIN is set but not an absolute normalized path.\n");
  process.exit(1);
}
const outRoot = path.join(repo, ".smoke", "recovered-owned");
mkdirSync(outRoot, { recursive: true, mode: 0o700 });

/** Sanitized state/code of the failed MCP job, from its own smoke evidence (repo-local). */
function failedJob() {
  try {
    const ev = JSON.parse(readFileSync(path.join(repo, FAILED_JOB_EVIDENCE), "utf8"));
    const final = ev.steps?.find((s) => s.step === "final")?.data;
    return { evidence: FAILED_JOB_EVIDENCE, state: final?.state ?? null, error_code: final?.error?.code ?? null };
  } catch {
    return { evidence: FAILED_JOB_EVIDENCE, state: null, error_code: null };
  }
}

const evidence = { started_at: new Date().toISOString(), codex_version: await codexVersion() };
let exitCode = 0;
try {
  const r = await recoverOwnedImage({
    threadId,
    createTransport: () => spawnAppServer({ bin, cwd: realpathSync(os.tmpdir()) }),
    codexHome: codexHome(),
    outputRoot: outRoot,
    clientVersion: SERVER_VERSION,
  });
  Object.assign(evidence, r);
  if (!r.recovered) exitCode = 1;
} catch {
  evidence.error = "recovery failed";
  exitCode = 1;
}
// The MCP job outcome is reported separately and unchanged: recovery does not make it a success.
evidence.mcp_image_job = failedJob();
evidence.finished_at = new Date().toISOString();
const out = path.join(outRoot, `evidence-${randomUUID()}.json`);
writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(`evidence: ${path.relative(repo, out)} (exit ${exitCode})\n`);
process.exit(exitCode);
