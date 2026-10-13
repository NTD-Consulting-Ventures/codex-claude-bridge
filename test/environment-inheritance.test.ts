// OPT-IN LIVE: runs the real official Claude CLI (absolute path in BRIDGE_TEST_CLAUDE_BIN),
// otherwise skipped. Only `claude mcp add-json --scope user` and `claude mcp get` are run,
// against a throwaway CLAUDE_CONFIG_DIR and HOME; `mcp get` only checks that the built
// server connects. CODEX_BIN points at a nonexistent path, so no Codex process, job, model
// call or image can start. No credentials or real config are read or printed.
//
// Establishes how the MCP child's CODEX_BRIDGE_MODE is resolved: the stored entry env wins
// over the environment Claude was launched with; with neither, the server defaults to general.
// An invalid value makes the server exit before connecting, so connect/fail shows which
// value the child actually received.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const claudeBin = process.env.BRIDGE_TEST_CLAUDE_BIN;
const skip =
  claudeBin === undefined || !path.isAbsolute(claudeBin)
    ? "set BRIDGE_TEST_CLAUDE_BIN to the absolute path of the official claude binary"
    : false;

const serverJs = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "dist", "src", "server.js");
const NAME = "codex-claude-bridge-envtest";
const SENTINEL = "BRIDGE_TEST_SENTINEL=keep-me";
const INVALID_AMBIENT = "bogus-ambient-7f3a";
const INVALID_STORED = "bogus-stored-9c1e";
const TIMEOUT_MS = 60_000;

type Case = { stored: string | undefined; ambient: string | undefined; connects: boolean };

const cases: Case[] = [
  { stored: undefined, ambient: undefined, connects: true },
  { stored: undefined, ambient: "general", connects: true },
  { stored: undefined, ambient: "image-only", connects: true },
  { stored: undefined, ambient: INVALID_AMBIENT, connects: false },
  { stored: "general", ambient: "image-only", connects: true },
  { stored: "general", ambient: INVALID_AMBIENT, connects: true },
  { stored: "image-only", ambient: "general", connects: true },
  { stored: "image-only", ambient: INVALID_AMBIENT, connects: true },
  { stored: INVALID_STORED, ambient: "image-only", connects: false },
  { stored: INVALID_STORED, ambient: "general", connects: false },
];

function runClaude(root: string, ambient: string | undefined, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "config"),
    TMPDIR: path.join(root, "tmp"),
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (ambient !== undefined) env.CODEX_BRIDGE_MODE = ambient;
  return spawnSync(claudeBin as string, args, { cwd: path.join(root, "cwd"), env, encoding: "utf8", timeout: TIMEOUT_MS });
}

for (const c of cases) {
  test(`claude mcp: stored ${c.stored ?? "(absent)"}, ambient ${c.ambient ?? "(absent)"} → ${c.connects ? "connects" : "fails"}`, { skip, timeout: 3 * TIMEOUT_MS }, () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-env-")));
    try {
      for (const d of ["home", "config", "tmp", "cwd", "out"]) mkdirSync(path.join(root, d));
      const storedEnv: Record<string, string> = {
        CODEX_BIN: "/nonexistent/codex",
        CODEX_IMAGE_OUTPUT_ROOT: path.join(root, "out"),
        BRIDGE_TEST_SENTINEL: "keep-me",
      };
      if (c.stored !== undefined) storedEnv.CODEX_BRIDGE_MODE = c.stored;
      const entry = JSON.stringify({ type: "stdio", command: process.execPath, args: [serverJs], env: storedEnv });

      const add = runClaude(root, c.ambient, ["mcp", "add-json", "--scope", "user", NAME, entry]);
      assert.equal(add.error, undefined);
      assert.equal(add.status, 0, "mcp add-json failed");

      const get = runClaude(root, c.ambient, ["mcp", "get", NAME]);
      assert.equal(get.error, undefined);
      const out = `${get.stdout}\n${get.stderr}`;
      const lines = get.stdout.split("\n");
      const status = lines.find((l) => /^\s*Status:/.test(l));
      assert.ok(status !== undefined, "mcp get printed no Status line");
      assert.equal(/Connected/.test(status) && !/Failed/i.test(status), c.connects, status);

      // Readback holds exactly the stored mode (or none), never the inherited ambient one.
      const modeLines = lines.filter((l) => /^\s+CODEX_BRIDGE_MODE=/.test(l)).map((l) => l.trim());
      assert.deepEqual(modeLines, c.stored === undefined ? [] : [`CODEX_BRIDGE_MODE=${c.stored}`]);
      assert.ok(lines.some((l) => l.trim() === SENTINEL), "sentinel env entry missing from readback");
      assert.ok(!out.includes(INVALID_AMBIENT), "invalid ambient value echoed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
