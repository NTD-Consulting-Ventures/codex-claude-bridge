#!/usr/bin/env node
// Registers codex-claude-bridge with Claude Code via the official CLI only:
//   claude mcp add --transport stdio --scope user codex-claude-bridge -e CODEX_BIN=<abs> -e CODEX_IMAGE_OUTPUT_ROOT=<abs> -- <node> <dist/src/server.js>
// Before any add it probes BOTH the canonical ID and the legacy ID
// codex-image-mcp; if either exists it stops (exit 2) and leaves it as is, if
// either answer is not understood it stops (exit 3). It never reads or writes
// ~/.claude.json directly, never removes, renames or overwrites a
// registration, and never installs, downloads or signs in to anything. Default
// is a dry run; pass --apply to register, after which the official
// `claude mcp get` readback must match exactly or the script fails (exit 4)
// without claiming success.
//
// --check-auth (alone) registers nothing: it runs `codex login status` and
// `claude auth status` with the discovered absolute paths and the shared
// launch env, reports only their exit status (their output, which may
// identify the account, is not echoed) and, when one is not signed in, prints
// the official login command to run yourself (exit 5).
//
// Discovery (src/discover.ts): CLAUDE_BIN / CODEX_BIN when set (no fallback if
// unusable), else PATH, ~/.local/bin, /opt/homebrew/bin (macOS),
// /usr/local/bin, then `npm prefix -g`/bin. The absolute Codex path, the
// current Node (process.execPath) and the image output root are always
// persisted, so Claude Desktop does not depend on the Terminal's PATH.
//
// Bridge mode (src/bridge-mode.ts): CODEX_BRIDGE_MODE=general|image-only is
// validated with the server's resolver before anything is discovered, probed
// or added (also with --check-auth, which otherwise ignores it), and persisted as `-e CODEX_BRIDGE_MODE=<mode>` only when set
// (unset: the same argv as 0.2.1). It changes the listed MCP tools only, not
// the Codex launch policy (docs/image-only.md). Existing registrations are
// never updated to a mode by this script.
//
// Exit codes: 0 ok / dry run / signed in, 1 setup error, 2 already registered
// (canonical or legacy ID), 3 could not confirm absence, 4 apply or readback
// failed, 5 (--check-auth) sign-in not confirmed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(repo, "dist", "src", "server.js");
const dist = path.join(repo, "dist", "src");
const node = process.execPath;
const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const checkAuth = argv.includes("--check-auth");
const out = (s) => process.stdout.write(`${s}\n`);
const fail = (code, s) => {
  process.stderr.write(`${s}\n`);
  process.exit(code);
};
// POSIX single-quoting for commands printed for the user to copy.
const sq = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const usage = "Usage: npm run register [-- --apply | -- --check-auth]";
if (argv.some((a) => a !== "--apply" && a !== "--check-auth") || (apply && checkAuth) || new Set(argv).size !== argv.length) fail(1, usage);
if (!path.isAbsolute(node) || !existsSync(serverJs) || !existsSync(path.join(dist, "install.js"))) {
  fail(1, "Build first (npm run build); dist/src/server.js not found.");
}
const {
  addArgs,
  classifyProbe,
  describeProbe,
  registrationEnv,
  resolveRegisteredBridgeMode,
  resolveRegisteredOutputRoot,
  verifyReadback,
  KNOWN_SERVER_NAMES,
  SERVER_NAME: NAME,
} = await import(path.join(dist, "install.js"));
const { checkClaudeVersion, checkCodexVersion, discoverExecutable, INSTALL_GUIDANCE, spawnRunner } = await import(path.join(dist, "discover.js"));
const { currentNodeDir, launcherKind, launchEnv } = await import(path.join(dist, "launch.js"));

const deps = { env: process.env, platform: process.platform, home: os.homedir(), execPath: node, run: spawnRunner };
const nodeDir = currentNodeDir(node);

// Validated in every mode, --check-auth included, before any discovery.
// Static reason only: the raw CODEX_BRIDGE_MODE value is never echoed.
const bridgeMode = resolveRegisteredBridgeMode(process.env);
if (!bridgeMode.ok) fail(1, `${bridgeMode.reason}; not registering.`);
const outRoot = checkAuth ? null : resolveRegisteredOutputRoot(process.env);
if (outRoot && !outRoot.ok) fail(1, `${outRoot.reason}; not registering.`);

const claude = discoverExecutable("claude", "CLAUDE_BIN", deps);
if (!claude.ok) fail(1, `Claude Code CLI: ${claude.reason}.\n${INSTALL_GUIDANCE.claude}`);
const claudeVersion = checkClaudeVersion(claude.path, deps);
if (!claudeVersion.ok) fail(1, `Claude Code CLI at ${claude.path}: ${claudeVersion.reason}.\n${INSTALL_GUIDANCE.claude}`);

const codex = discoverExecutable("codex", "CODEX_BIN", deps);
if (!codex.ok) fail(1, `Codex CLI: ${codex.reason}.\n${INSTALL_GUIDANCE.codex}`);
const codexKind = launcherKind(codex.path);
const codexVersion = checkCodexVersion(codex.path, deps);
if (!codexVersion.ok) {
  const hint = codexKind === "node_shebang" && !nodeDir.verified ? `\nIt is a Node launcher, and ${node} has no sibling \`node\` to put on PATH.` : "";
  fail(1, `Codex CLI at ${codex.path}: ${codexVersion.reason}.${hint}\n${INSTALL_GUIDANCE.codex}`);
}

out(`Node:        ${node} (${process.version}${nodeDir.verified ? ", put first on the PATH of Codex/Claude children" : ""})`);
out(`Claude Code: ${claude.path} (${claudeVersion.version}, found via ${claude.source}, ${launcherKind(claude.path)})`);
out(`Codex CLI:   ${codex.path} (${codexVersion.version}, found via ${codex.source}, ${codexKind})`);

const childEnv = launchEnv(process.env, node);
const run = (bin, args, timeout = 30_000) =>
  spawnSync(bin, args, {
    shell: false,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

if (checkAuth) {
  // Same PATH prefix the children got, so npm (`#!/usr/bin/env node`) launchers start.
  const prefix = nodeDir.verified ? `PATH=${sq(nodeDir.dir)}:"$PATH" ` : "";
  const checks = [
    { label: "Codex sign-in", bin: codex.path, args: ["login", "status"], login: ["login"] },
    { label: "Claude sign-in", bin: claude.path, args: ["auth", "status"], login: ["auth", "login"] },
  ];
  let missing = 0;
  for (const c of checks) {
    const r = run(c.bin, c.args);
    if (!r.error && r.signal === null && r.status === 0) {
      out(`${c.label}: signed in (\`${c.args.join(" ")}\` exit 0)`);
      continue;
    }
    missing++;
    const why = r.error ? `could not run (${r.error.code ?? "error"})` : r.signal !== null ? `stopped by ${r.signal}` : `exit ${r.status}`;
    out(`${c.label}: not confirmed (\`${c.args.join(" ")}\` ${why}). Sign in yourself with:`);
    out(`  ${prefix}${sq(c.bin)} ${c.login.join(" ")}`);
  }
  out("Registration does not depend on sign-in; nothing was changed.");
  process.exit(missing === 0 ? 0 : 5);
}

out(`Image output root (${outRoot.source}): ${outRoot.path}`);
out(
  bridgeMode.persist === undefined
    ? `Bridge mode (default): ${bridgeMode.mode} (CODEX_BRIDGE_MODE not set, so not stored)`
    : `Bridge mode (env): ${bridgeMode.mode} (stored as CODEX_BRIDGE_MODE=${bridgeMode.persist})`,
);
if (bridgeMode.mode === "image-only") {
  out("  image-only hides codex_task_start from the MCP tool list and refuses direct calls to it (TOOL_DISABLED).");
  out("  It is NOT a sandbox: native Codex capabilities are unchanged; image jobs still run under your native");
  out("  Codex config, plugins and MCP servers (docs/image-only.md).");
}

const get = (name) => run(claude.path, ["mcp", "get", name]);

// Probe every known ID before any add; nothing is mutated unless all are absent.
const probes = KNOWN_SERVER_NAMES.map((name) => ({ name, probe: get(name) }));
const verdicts = probes.map((p) => ({ ...p, verdict: classifyProbe(p.probe, p.name) }));
if (verdicts.some((v) => v.verdict === "cli_missing")) fail(1, `Claude Code CLI could not be started at ${claude.path}.\n${INSTALL_GUIDANCE.claude}`);
const existing = verdicts.filter((v) => v.verdict === "exists").map((v) => v.name);
if (existing.length > 0) {
  const legacy = existing.some((n) => n !== NAME) ? " An existing registration under the earlier ID keeps working as it is." : "";
  fail(
    2,
    `An MCP server named ${existing.map((n) => `"${n}"`).join(" and ")} is already registered; not adding another, not overwriting or removing it.${legacy}\n` +
      existing.map((n) => `Inspect it with: ${sq(claude.path)} mcp get ${n}`).join("\n") +
      "\n(to change paths or Node see docs/setup.md, \"Updating\"; to opt an existing entry into image-only see docs/image-only.md).",
  );
}
const unclear = verdicts.filter((v) => v.verdict !== "absent");
if (unclear.length > 0) {
  fail(3, unclear.map((v) => `Could not confirm that no MCP server named "${v.name}" exists (claude mcp get: ${describeProbe(v.probe, v.name)}).`).join("\n") + " Not registering.");
}

const args = addArgs(node, serverJs, codex.path, outRoot.path, bridgeMode.persist);
out(`Command: ${JSON.stringify(claude.path)} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
if (!apply) {
  out("Dry run. Re-run with --apply to register.");
  process.exit(0);
}

const add = spawnSync(claude.path, args, { shell: false, stdio: ["ignore", "inherit", "inherit"], timeout: 60_000, killSignal: "SIGKILL", env: childEnv });
if (add.error || add.signal !== null || add.status !== 0) {
  fail(4, `claude mcp add failed (${describeProbe(add)}); registration not confirmed.`);
}
const problems = verifyReadback(get(NAME), { node, serverJs, env: registrationEnv(codex.path, outRoot.path, bridgeMode.persist) }, NAME);
if (problems.length > 0) {
  fail(4, `Readback via claude mcp get did not match the requested registration; NOT confirmed:\n  - ${problems.join("\n  - ")}\nInspect with: ${sq(claude.path)} mcp get ${NAME}`);
}
out(`Registered and verified "${NAME}" (user scope, bridge mode ${bridgeMode.mode}).`);
out("Optional sign-in check: npm run register -- --check-auth");
out("Start a new Claude Code session (in Claude Desktop: a new Code session) to use it.");
