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

test("conflict probe: only the exact verified claude 2.1.293 configured-servers form allows registering", () => {
  // Receipt: .harness-evidence/corrective-probe.json (isolated CLAUDE_CONFIG_DIR): exit 1,
  // stdout empty, stderr exactly this single line.
  const prefix = `No MCP server named "${SERVER_NAME}". Configured servers: `;
  const actualNotFound = `${prefix}alpha, beta-tools, ${SERVER_NAME}-old\n`;
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: "", stderr: actualNotFound }), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stderr: actualNotFound }), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: "", stderr: `${prefix}alpha\n` }), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stdout: "", stderr: `${prefix}a_b, X9\n` }), "absent");
  // Exit 0 = exists in any scope (user, project, local); never overwritten.
  for (const scope of ["User", "Project", "Local"]) {
    assert.equal(classifyProbe({ status: 0, signal: null, stdout: `${SERVER_NAME}:\n  Scope: ${scope} config` }), "exists");
  }
  assert.equal(classifyProbe({ status: null, signal: null, error: { code: "ENOENT" } }), "cli_missing");
  const err = (stderr: string, stdout = "") => ({ status: 1, signal: null, stdout, stderr });
  const inconclusive = [
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: { code: "ETIMEDOUT" } },
    err("network error"),
    // unverified older/other shapes
    err(`No MCP server found with name: "${SERVER_NAME}"`),
    err("", `No MCP server found with name: "${SERVER_NAME}"`),
    err(`No MCP server named "other-server". Configured servers: x\n`),
    err(`No MCP server named "${SERVER_NAME}x". Configured servers: x\n`),
    // stdout-only, or wrong exit
    err("", actualNotFound),
    { status: 2, signal: null, stdout: "", stderr: actualNotFound },
    // mixed streams, including whitespace-only stdout
    err(actualNotFound, "warning"),
    err(actualNotFound, actualNotFound),
    err(actualNotFound, " "),
    err(actualNotFound, "\n"),
    err("", ""),
    err(" \n"),
    // prepended/appended warnings, missing or extra newline, leading space, CRLF, oversize
    err(`warning\n${actualNotFound}`),
    err(`${actualNotFound}warning\n`),
    err(`${actualNotFound}\n`),
    err(actualNotFound.trimEnd()),
    err(` ${actualNotFound}`),
    err(actualNotFound.replace("\n", "\r\n")),
    err(actualNotFound + "x".repeat(5000)),
    // bare prefix and empty list
    err(`No MCP server named "${SERVER_NAME}". Configured servers:\n`),
    err(`No MCP server named "${SERVER_NAME}". Configured servers:`),
    err(`${prefix}\n`),
    err(`${prefix} \n`),
    // contradictory: claims not found but lists the exact name
    err(`${prefix}alpha, ${SERVER_NAME}\n`),
    err(`${prefix}${SERVER_NAME}\n`),
    err(`No MCP server named "${SERVER_NAME}". Configured servers:\n  ${SERVER_NAME} (project)\n`),
    // duplicates and ambiguous / malformed entries, control characters
    err(`${prefix}alpha, alpha\n`),
    err(`${prefix}alpha,beta\n`),
    err(`${prefix}alpha, \n`),
    err(`${prefix}, alpha\n`),
    err(`${prefix}alpha,  beta\n`),
    err(`${prefix}alpha , beta\n`),
    err(`${prefix}alpha, beta \n`),
    err(`${prefix}alpha (project), beta\n`),
    err(`${prefix}"alpha", beta\n`),
    err(`${prefix}alpha\tbeta\n`),
    err(`${prefix}alpha\u0000, beta\n`),
    err(`${prefix}alpha\u001b[0m\n`),
    err(`${prefix}-alpha\n`),
    err(`${prefix}al.pha\n`),
    err(`${prefix}${"a".repeat(65)}\n`),
  ];
  for (const p of inconclusive) assert.equal(classifyProbe(p), "inconclusive", JSON.stringify(p).slice(0, 120));
});
