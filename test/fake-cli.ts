// Fake official CLIs for installer tests: executable `#!/usr/bin/env node`
// scripts (the npm launcher shape) written into temporary directories. They
// need `node` on PATH, so they only run when the shared launch environment
// supplies it. Nothing here touches a real Claude or Codex configuration.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmpdir = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-inst-")));

export function writeExec(file: string, body: string, mode = 0o755): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

export const nodeScript = (js: string): string => `#!/usr/bin/env node\n${js}\n`;

export function fakeCodex(file: string, versionLine = "codex-cli 9.9.9\n"): string {
  return writeExec(
    file,
    nodeScript(
      `if (process.argv[2] === "--version") { process.stdout.write(${JSON.stringify(versionLine)}); process.exit(0); }\n` +
        `if (process.argv[2] === "login" && process.argv[3] === "status") {\n` +
        `  if (process.env.FAKE_CODEX_LOGGED_OUT) { process.stderr.write("Not logged in\\n"); process.exit(1); }\n` +
        `  process.stdout.write("Logged in using ChatGPT (codex-identity@example.invalid)\\n"); process.exit(0);\n` +
        `}\n` +
        `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), node: process.execPath }) + "\\n");`,
    ),
  );
}

export function fakeNpm(file: string, stdout: string, status = 0): string {
  return writeExec(file, nodeScript(`process.stdout.write(${JSON.stringify(stdout)}); process.exit(${status});`));
}

/**
 * Fake `claude`: --version, `mcp get <name>` and `mcp add …` against a JSON
 * state file (FAKE_CLAUDE_STATE); every argv is appended to FAKE_CLAUDE_LOG.
 * FAKE_CLAUDE_MODE: "" | "connectors" (claude.ai connectors and a plugin
 * server listed first) | "warn" | "add_fail" | "readback_mismatch".
 * FAKE_CLAUDE_WARN_NAME: warn only when probing that name. FAKE_CLAUDE_LOGGED_OUT:
 * `auth status` exits 1. Not-found listings show 8 names, then the suffix
 * observed with claude 2.1.295 (.harness-evidence/claude295-probe.json).
 * Readback text follows the shape of the official `claude mcp get` output.
 */
export function fakeClaude(file: string): string {
  return writeExec(
    file,
    nodeScript(`
const fs = require("node:fs");
const a = process.argv.slice(2);
const st = process.env.FAKE_CLAUDE_STATE;
const mode = process.env.FAKE_CLAUDE_MODE || "";
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(a) + "\\n");
const load = () => (fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, "utf8")) : {});
if (a[0] === "--version") { process.stdout.write("2.1.295 (Claude Code)\\n"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") {
  if (process.env.FAKE_CLAUDE_LOGGED_OUT) { process.stdout.write('{"loggedIn": false}\\n'); process.exit(1); }
  process.stdout.write('{"loggedIn": true, "email": "claude-identity@example.invalid"}\\n'); process.exit(0);
}
if (a[0] === "mcp" && a[1] === "get") {
  const s = load();
  const e = s[a[2]];
  if (e) {
    let o = a[2] + ":\\n  Scope: User config (available in all your projects)\\n  Status: \\u2713 Connected\\n  Type: stdio\\n";
    o += "  Command: " + e.command + "\\n  Args: " + e.args.join(" ") + "\\n";
    const env = Object.entries(e.env);
    if (env.length) o += "  Environment:\\n" + env.map(([k, v]) => "    " + k + "=" + v + "\\n").join("");
    o += "\\nTo remove this server, run: claude mcp remove \\"" + a[2] + "\\" -s user\\n";
    process.stdout.write(o);
    process.exit(0);
  }
  const names = mode === "connectors" ? ["claude.ai Gmail", "claude.ai Google Drive", "plugin:github:github", ...Object.keys(s)] : Object.keys(s);
  if (mode === "warn" || process.env.FAKE_CLAUDE_WARN_NAME === a[2]) process.stderr.write("Warning: config migrated\\n");
  if (names.length === 0) {
    process.stderr.write('No MCP server named "' + a[2] + '". Run \`claude mcp add\` to add one.\\n');
  } else {
    const more = names.length > 8 ? " (and " + (names.length - 8) + " more \\u2014 run \`claude mcp list\` to see all)" : "";
    process.stderr.write('No MCP server named "' + a[2] + '". Configured servers: ' + names.slice(0, 8).join(", ") + more + "\\n");
  }
  process.exit(1);
}
if (a[0] === "mcp" && a[1] === "add") {
  if (mode === "add_fail") { process.stderr.write("add failed\\n"); process.exit(1); }
  const sep = a.indexOf("--");
  const head = a.slice(2, sep);
  const name = head[4];
  const s = load();
  if (s[name]) { process.stderr.write("exists\\n"); process.exit(1); }
  const env = {};
  for (let i = 5; i < head.length; i += 2) {
    if (head[i] !== "-e") process.exit(9);
    const kv = head[i + 1];
    env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
  }
  if (mode === "readback_mismatch") delete env.CODEX_IMAGE_OUTPUT_ROOT;
  s[name] = { command: a[sep + 1], args: a.slice(sep + 2), env, scope: head[3] };
  fs.writeFileSync(st, JSON.stringify(s));
  process.stdout.write("Added stdio MCP server " + name + "\\n");
  process.exit(0);
}
process.exit(2);
`),
  );
}
