// NON-LIVE: installer planning only; no claude or codex process is spawned.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addArgs, classifyProbe, EMPTY_CONFIG_NOT_FOUND, resolveClaudeBin, resolveRegisteredCodexBin, resolveRegisteredOutputRoot, SERVER_NAME } from "../src/install.js";

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

test("add argv: name precedes every -e (claude 2.1.293 -e is variadic), then -- node server", () => {
  // Paths with spaces must stay single argv tokens.
  const node = "/Users/u/My Tools/node";
  const server = "/Users/u/My Code/codex-image-mcp/dist/src/server.js";
  const codexEnv = { ok: true as const, path: "/Users/u/Codex Bin/codex", source: "env" as const };
  const codexDef = { ok: true as const, path: "/Users/u/.local/bin/codex", source: "default" as const };
  const root = "/Users/u/Codex Images";
  const head = ["mcp", "add", "--transport", "stdio", "--scope", "user", "codex-image-mcp"];
  assert.equal(SERVER_NAME, "codex-image-mcp");
  // neither
  assert.deepEqual(addArgs(node, server, codexDef), [...head, "--", node, server]);
  assert.deepEqual(addArgs(node, server, codexDef, null), [...head, "--", node, server]);
  // CODEX_BIN only
  assert.deepEqual(addArgs(node, server, codexEnv), [...head, "-e", "CODEX_BIN=/Users/u/Codex Bin/codex", "--", node, server]);
  // output root only
  assert.deepEqual(addArgs(node, server, codexDef, root), [...head, "-e", "CODEX_IMAGE_OUTPUT_ROOT=/Users/u/Codex Images", "--", node, server]);
  // both
  assert.deepEqual(addArgs(node, server, codexEnv, root), [
    ...head,
    "-e", "CODEX_BIN=/Users/u/Codex Bin/codex",
    "-e", "CODEX_IMAGE_OUTPUT_ROOT=/Users/u/Codex Images",
    "--", node, server,
  ]);
});

test("resolved output root (default or override) is forwarded consistently; invalid (incl. empty) fails closed", () => {
  const head = ["mcp", "add", "--transport", "stdio", "--scope", "user", "codex-image-mcp"];
  const codexEnv = { ok: true as const, path: "/c", source: "env" as const };
  const def = resolveRegisteredOutputRoot({}, () => "/Users/u");
  assert.deepEqual(def, { ok: true, path: "/Users/u/codex-images", source: "default" });
  const ovr = resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: "/Users/u/img" });
  assert.deepEqual(ovr, { ok: true, path: "/Users/u/img", source: "env" });
  for (const r of [def, ovr]) {
    assert.ok(r.ok);
    // Name stays before every variadic -e.
    assert.deepEqual(addArgs("/n", "/s.js", codexEnv, r.path), [...head, "-e", "CODEX_BIN=/c", "-e", `CODEX_IMAGE_OUTPUT_ROOT=${r.path}`, "--", "/n", "/s.js"]);
  }
  for (const bad of ["", "img", "./img", "/a/../img", "/a//img", "/img/", "/", "/a\0b"]) {
    assert.equal(resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: bad }).ok, false, JSON.stringify(bad));
  }
});

test("empty-config probe: only the exact verified claude 2.1.293 form is absent", () => {
  // Receipt: .harness-evidence/empty-config-probe.json (isolated CLAUDE_CONFIG_DIR).
  const exact = 'No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.\n';
  assert.equal(EMPTY_CONFIG_NOT_FOUND, exact);
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: "", stderr: exact }), "absent");
  const bad = [
    { status: 1, signal: null, stdout: exact, stderr: "" },
    { status: 1, signal: null, stdout: "x", stderr: exact },
    { status: 1, signal: null, stdout: "", stderr: `warning\n${exact}` },
    { status: 1, signal: null, stdout: "", stderr: `${exact}warning\n` },
    { status: 1, signal: null, stdout: "", stderr: exact.trimEnd() },
    { status: 1, signal: null, stdout: "", stderr: exact + "\n" },
    { status: 1, signal: null, stdout: "", stderr: " " + exact },
    { status: 1, signal: null, stdout: "", stderr: exact.replace("codex-image-mcp", "other") },
    { status: 1, signal: null, stdout: "", stderr: exact.replace("Run", "run") },
    { status: 2, signal: null, stdout: "", stderr: exact },
    { status: null, signal: "SIGTERM", stdout: "", stderr: exact },
    { status: 1, signal: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: exact },
  ];
  for (const p of bad) assert.equal(classifyProbe(p), "inconclusive", JSON.stringify(p).slice(0, 120));
  assert.equal(classifyProbe({ status: 0, signal: null, stdout: "codex-image-mcp:\n  Scope: User config", stderr: "" }), "exists");
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
