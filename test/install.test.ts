// NON-LIVE: installer planning only; no claude or codex process is spawned.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addArgs, classifyProbe, resolveClaudeBin, resolveRegisteredCodexBin, resolveRegisteredOutputRoot, SERVER_NAME } from "../src/install.js";

test("CLAUDE_BIN / CODEX_BIN: absolute normalized paths accepted, anything else fails closed", () => {
  assert.deepEqual(resolveClaudeBin({}), { ok: true, path: "claude", source: "default" });
  assert.deepEqual(resolveClaudeBin({ CLAUDE_BIN: "/opt/homebrew/bin/claude" }), { ok: true, path: "/opt/homebrew/bin/claude", source: "env" });
  for (const bad of ["claude", "./claude", "/a/../claude", "/a//claude", "/a/b\0c"]) {
    assert.equal(resolveClaudeBin({ CLAUDE_BIN: bad }).ok, false, bad);
    assert.equal(resolveRegisteredCodexBin({ CODEX_BIN: bad }).ok, false, bad);
  }
  const c = resolveRegisteredCodexBin({ CODEX_BIN: "/opt/homebrew/bin/codex" });
  assert.deepEqual(c, { ok: true, path: "/opt/homebrew/bin/codex", source: "env" });
  assert.equal((resolveRegisteredCodexBin({}) as { source?: string }).source, "default");
});

test("add argv forwards CODEX_BIN only when explicitly set; name precedes the -- separator", () => {
  const env = addArgs("/usr/local/bin/node", "/r/dist/src/server.js", { ok: true, path: "/x/codex", source: "env" });
  assert.deepEqual(env, ["mcp", "add", "--transport", "stdio", "--scope", "user", "-e", "CODEX_BIN=/x/codex", SERVER_NAME, "--", "/usr/local/bin/node", "/r/dist/src/server.js"]);
  const def = addArgs("/n", "/s.js", { ok: true, path: "/h/.local/bin/codex", source: "default" });
  assert.ok(!def.includes("-e"));
  assert.equal(def.indexOf(SERVER_NAME) + 1, def.indexOf("--"));
});

test("CODEX_IMAGE_OUTPUT_ROOT is forwarded only when set and absolute; invalid fails closed", () => {
  assert.deepEqual(resolveRegisteredOutputRoot({}), { ok: true, path: null });
  assert.deepEqual(resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: "/Users/u/img" }), { ok: true, path: "/Users/u/img" });
  for (const bad of ["img", "./img", "/a/../img", "/a//img", "/", "/a\0b"]) {
    assert.equal(resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: bad }).ok, false, bad);
  }
  const a = addArgs("/n", "/s.js", { ok: true, path: "/x/codex", source: "env" }, "/Users/u/img");
  assert.deepEqual(a.slice(6), ["-e", "CODEX_BIN=/x/codex", "-e", "CODEX_IMAGE_OUTPUT_ROOT=/Users/u/img", SERVER_NAME, "--", "/n", "/s.js"]);
  assert.ok(!addArgs("/n", "/s.js", { ok: true, path: "/c", source: "default" }).some((x) => x.startsWith("CODEX_IMAGE_OUTPUT_ROOT=")));
});

test("conflict probe: only the exact claude 2.1.293 not-found answer allows registering", () => {
  // Fixture of the actual installed-CLI shape; the real configured-server list is not stored.
  const actualNotFound = `No MCP server named "${SERVER_NAME}". Configured servers: alpha, beta-tools, ${SERVER_NAME}-old\n`;
  // Actual subprocess capture: exit 1, stdout empty, not-found line on stderr.
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: "", stderr: actualNotFound }), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stderr: actualNotFound }), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: actualNotFound, stderr: "" }), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: `No MCP server named "${SERVER_NAME}". Configured servers: \n` }), "absent");
  // Exit 0 = exists in any scope (user, project, local); never overwritten.
  for (const scope of ["User", "Project", "Local"]) {
    assert.equal(classifyProbe({ status: 0, signal: null, stdout: `${SERVER_NAME}:\n  Scope: ${scope} config` }), "exists");
  }
  assert.equal(classifyProbe({ status: null, signal: null, error: { code: "ENOENT" } }), "cli_missing");
  const inconclusive = [
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: { code: "ETIMEDOUT" } },
    { status: 1, signal: null, stderr: "network error" },
    // unverified older/other shapes
    { status: 1, signal: null, stderr: `No MCP server found with name: "${SERVER_NAME}"` },
    { status: 1, signal: null, stdout: `No MCP server found with name: "${SERVER_NAME}"` },
    // other name, prefix not at start, wrong exit, noise on stderr, oversize
    { status: 1, signal: null, stdout: 'No MCP server named "other-server". Configured servers: x' },
    { status: 1, signal: null, stdout: `warning\n${actualNotFound}` },
    { status: 1, signal: null, stdout: `No MCP server named "${SERVER_NAME}x". Configured servers: x` },
    { status: 2, signal: null, stdout: actualNotFound },
    { status: 1, signal: null, stdout: actualNotFound, stderr: "Error: config parse failed" },
    // mixed: both streams non-empty, or nothing at all
    { status: 1, signal: null, stdout: "warning", stderr: actualNotFound },
    { status: 1, signal: null, stdout: actualNotFound, stderr: actualNotFound },
    { status: 1, signal: null, stdout: "", stderr: "" },
    { status: 1, signal: null, stderr: `warning\n${actualNotFound}` },
    { status: 2, signal: null, stderr: actualNotFound },
    { status: 1, signal: null, stdout: actualNotFound + "x".repeat(5000) },
    { status: 1, signal: null, stderr: actualNotFound + "x".repeat(5000) },
    { status: 1, signal: null, stderr: `No MCP server named "${SERVER_NAME}". Configured servers: alpha, ${SERVER_NAME}` },
    // conflicting: claims not found but lists the exact name
    { status: 1, signal: null, stdout: `No MCP server named "${SERVER_NAME}". Configured servers: alpha, ${SERVER_NAME}` },
    { status: 1, signal: null, stdout: `No MCP server named "${SERVER_NAME}". Configured servers:\n  ${SERVER_NAME} (project)` },
  ];
  for (const p of inconclusive) assert.equal(classifyProbe(p), "inconclusive", JSON.stringify(p).slice(0, 80));
});
