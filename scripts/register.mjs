#!/usr/bin/env node
// Registers this server with Claude Code via the official CLI only:
//   claude mcp add --transport stdio --scope user [-e CODEX_BIN=<abs>] [-e CODEX_IMAGE_OUTPUT_ROOT=<abs>] codex-image-mcp -- <node> <dist/src/server.js>
// It never reads or writes ~/.claude.json directly. It refuses to overwrite an
// existing registration of the same name. Default is a dry run; pass --apply to
// actually register.
//
// Portable: CLAUDE_BIN (absolute) selects the claude CLI instead of PATH;
// CODEX_BIN (absolute) is forwarded into the registration so the server uses
// it instead of ~/.local/bin/codex; CODEX_IMAGE_OUTPUT_ROOT (absolute) is
// forwarded to enable codex_image_generate. All fail closed when set but invalid.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(repo, "dist", "src", "server.js");
const installJs = path.join(repo, "dist", "src", "install.js");
const node = process.execPath;
const apply = process.argv.includes("--apply");

if (!path.isAbsolute(node) || !existsSync(serverJs) || !existsSync(installJs)) {
  process.stderr.write("Build first (npm run build); dist/src/server.js not found.\n");
  process.exit(1);
}
const { addArgs, classifyProbe, resolveClaudeBin, resolveRegisteredCodexBin, resolveRegisteredOutputRoot, SERVER_NAME: NAME } = await import(installJs);

const claude = resolveClaudeBin(process.env);
const codex = resolveRegisteredCodexBin(process.env);
const outRoot = resolveRegisteredOutputRoot(process.env);
for (const c of [claude, codex, outRoot]) {
  if (!c.ok) {
    process.stderr.write(`${c.reason}; not registering.\n`);
    process.exit(1);
  }
}
if (claude.source === "env" && !existsSync(claude.path)) {
  process.stderr.write("CLAUDE_BIN does not exist; not registering.\n");
  process.exit(1);
}
if (!existsSync(codex.path)) {
  process.stderr.write(`Warning: Codex CLI not found at ${codex.path}; the server will report it unavailable until installed.\n`);
}

const args = addArgs(node, serverJs, codex, outRoot.path);

const probe = spawnSync(claude.path, ["mcp", "get", NAME], { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
switch (classifyProbe(probe)) {
  case "cli_missing":
    process.stderr.write("Official `claude` CLI not found (set CLAUDE_BIN to its absolute path).\n");
    process.exit(1);
    break;
  case "exists":
    process.stderr.write(`An MCP server named "${NAME}" is already registered; not overwriting. Remove it first with: claude mcp remove ${NAME} --scope user\n`);
    process.exit(2);
    break;
  case "inconclusive":
    process.stderr.write(`Could not confirm that no MCP server named "${NAME}" exists (claude mcp get: inconclusive). Not registering.\n`);
    process.exit(3);
    break;
  default:
    break;
}

process.stdout.write(`Command: ${JSON.stringify(claude.path)} ${args.map((a) => JSON.stringify(a)).join(" ")}\n`);
if (!apply) {
  process.stdout.write("Dry run. Re-run with --apply to register.\n");
  process.exit(0);
}
const r = spawnSync(claude.path, args, { stdio: "inherit", timeout: 60_000 });
process.exit(r.status ?? 1);
