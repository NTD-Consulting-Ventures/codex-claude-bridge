// NON-LIVE: installer planning plus scripts/register.mjs run end to end against
// a fake `claude` CLI (test/fake-cli.ts) with a temporary state file. No real
// claude or codex process is spawned and no real Claude config is touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addArgs,
  classifyProbe,
  EMPTY_CONFIG_NOT_FOUND,
  emptyConfigNotFound,
  KNOWN_SERVER_NAMES,
  LEGACY_SERVER_NAME,
  parseConfiguredList,
  registrationEnv,
  resolveRegisteredBridgeMode,
  resolveRegisteredOutputRoot,
  SERVER_NAME,
  verifyReadback,
} from "../src/install.js";
import { BRIDGE_MODE_INVALID_MESSAGE, type BridgeMode } from "../src/bridge-mode.js";
import { launchEnv } from "../src/launch.js";
import { fakeClaude, fakeCodex, nodeScript, tmpdir, writeExec } from "./fake-cli.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const head = ["mcp", "add", "--transport", "stdio", "--scope", "user", "codex-claude-bridge"];

test("names: canonical ID for new registrations; legacy ID only detected; both probed", () => {
  assert.equal(SERVER_NAME, "codex-claude-bridge");
  assert.equal(LEGACY_SERVER_NAME, "codex-image-mcp");
  assert.deepEqual(KNOWN_SERVER_NAMES, ["codex-claude-bridge", "codex-image-mcp"]);
});

test("add argv: name precedes every -e (claude 2.1.293 -e is variadic); CODEX_BIN and output root always persisted", () => {
  // Paths with spaces must stay single argv tokens.
  const node = "/Users/example-user/My Tools/node";
  const server = "/Users/example-user/My Code/codex-claude-bridge/dist/src/server.js";
  assert.deepEqual(addArgs(node, server, "/Users/example-user/Codex Bin/codex", "/Users/example-user/Codex Images"), [
    ...head,
    "-e", "CODEX_BIN=/Users/example-user/Codex Bin/codex",
    "-e", "CODEX_IMAGE_OUTPUT_ROOT=/Users/example-user/Codex Images",
    "--", node, server,
  ]);
});

const INVALID_MODES = ["", " ", "\t", "Image-Only", "image_only", " image-only", "image-only ", "GENERAL", "SECRET-mode"];

test("bridge mode: optional; unset payload identical to 0.2.1; explicit general|image-only persisted; invalid rejected", () => {
  const base = registrationEnv("/c/codex", "/o");
  assert.deepEqual(base, { CODEX_BIN: "/c/codex", CODEX_IMAGE_OUTPUT_ROOT: "/o" });
  assert.deepEqual(registrationEnv("/c/codex", "/o", undefined), base);
  assert.deepEqual(addArgs("/n", "/s.js", "/c/codex", "/o", undefined), addArgs("/n", "/s.js", "/c/codex", "/o"));
  for (const mode of ["general", "image-only"] as const) {
    assert.deepEqual(registrationEnv("/c/codex", "/o", mode), { ...base, CODEX_BRIDGE_MODE: mode });
    assert.deepEqual(addArgs("/n", "/s.js", "/c/codex", "/o", mode), [
      ...head,
      "-e", "CODEX_BIN=/c/codex",
      "-e", "CODEX_IMAGE_OUTPUT_ROOT=/o",
      "-e", `CODEX_BRIDGE_MODE=${mode}`,
      "--", "/n", "/s.js",
    ]);
  }
  for (const bad of INVALID_MODES) {
    assert.throws(() => registrationEnv("/c/codex", "/o", bad as BridgeMode), { message: BRIDGE_MODE_INVALID_MESSAGE });
    assert.throws(() => addArgs("/n", "/s.js", "/c/codex", "/o", bad as BridgeMode), TypeError);
    assert.deepEqual(resolveRegisteredBridgeMode({ CODEX_BRIDGE_MODE: bad }), { ok: false, reason: BRIDGE_MODE_INVALID_MESSAGE });
  }
  assert.deepEqual(resolveRegisteredBridgeMode({}), { ok: true, mode: "general", persist: undefined });
  assert.deepEqual(resolveRegisteredBridgeMode({ CODEX_BRIDGE_MODE: "general" }), { ok: true, mode: "general", persist: "general" });
  assert.deepEqual(resolveRegisteredBridgeMode({ CODEX_BRIDGE_MODE: "image-only" }), { ok: true, mode: "image-only", persist: "image-only" });
});

test("resolved output root (default or override) is forwarded; invalid (incl. empty) fails closed", () => {
  const def = resolveRegisteredOutputRoot({}, () => "/Users/example-user");
  assert.deepEqual(def, { ok: true, path: "/Users/example-user/codex-images", source: "default" });
  assert.deepEqual(resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: "/Users/example-user/img" }), { ok: true, path: "/Users/example-user/img", source: "env" });
  for (const bad of ["", "img", "./img", "/a/../img", "/a//img", "/img/", "/", "/a\0b"]) {
    assert.equal(resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: bad }).ok, false, JSON.stringify(bad));
  }
});

const err = (stderr: string, stdout = "") => ({ status: 1, signal: null, stdout, stderr });
const prefix = `No MCP server named "${SERVER_NAME}". Configured servers: `;
const more = (n: number) => ` (and ${n} more — run \`claude mcp list\` to see all)`;
const sentinels = Array.from({ length: 19 }, (_, i) => `sentinel-${String(i).padStart(2, "0")}`);
/** Exact stderr of official claude 2.1.295 with 19 user-scope servers; receipt .harness-evidence/claude295-probe.json. */
const OBSERVED_295 =
  'No MCP server named "codex-image-mcp". Configured servers: sentinel-00, sentinel-01, sentinel-02, sentinel-03, sentinel-04, sentinel-05, sentinel-06, sentinel-07 (and 11 more — run `claude mcp list` to see all)\n';

test("probe: observed empty-config forms are absent; exit 0 exists; ENOENT cli_missing", () => {
  assert.equal(EMPTY_CONFIG_NOT_FOUND, 'No MCP server named "codex-claude-bridge". Run `claude mcp add` to add one.\n');
  // Receipt .harness-evidence/claude295-probe.json (same text as with 2.1.293).
  assert.equal(classifyProbe(err('No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.\n'), LEGACY_SERVER_NAME), "absent");
  for (const name of KNOWN_SERVER_NAMES) {
    assert.equal(classifyProbe(err(emptyConfigNotFound(name)), name), "absent");
    for (const scope of ["User", "Project", "Local"]) {
      assert.equal(classifyProbe({ status: 0, signal: null, stdout: `${name}:\n  Scope: ${scope} config` }, name), "exists");
    }
  }
  // Untruncated shape verified with 2.1.293 (isolated CLAUDE_CONFIG_DIR).
  assert.equal(classifyProbe(err(`${prefix}alpha, beta-tools, ${SERVER_NAME}-old\n`)), "absent");
  assert.equal(classifyProbe({ status: 1, signal: null, stderr: `${prefix}alpha\n` }), "absent");
  assert.equal(classifyProbe({ status: null, signal: null, error: { code: "ENOENT" } }), "cli_missing");
});

test("probe: actual claude 2.1.295 truncated listing is absent via the named diagnostic (legacy and canonical)", () => {
  assert.equal(classifyProbe(err(OBSERVED_295), LEGACY_SERVER_NAME), "absent");
  assert.equal(classifyProbe(err(OBSERVED_295.replace(LEGACY_SERVER_NAME, SERVER_NAME)), SERVER_NAME), "absent");
  // A diagnostic naming the legacy ID proves nothing about the canonical one.
  assert.equal(classifyProbe(err(OBSERVED_295), SERVER_NAME), "inconclusive");
  const list = OBSERVED_295.slice(`No MCP server named "${LEGACY_SERVER_NAME}". Configured servers: `.length, -1);
  assert.deepEqual(parseConfiguredList(list), { names: sentinels.slice(0, 8), truncated: true, more: 11 });
  const absent = [
    `${prefix}claude.ai Gmail, claude.ai Google Drive, alpha${more(16)}\n`,
    `${prefix}claude.ai Gmail\n`,
    `${prefix}plugin:github:github, claude.ai Notion, beta-tools\n`,
    `${prefix}alpha${more(1)}\n`,
    `${prefix}${LEGACY_SERVER_NAME}, alpha${more(3)}\n`,
  ];
  for (const s of absent) assert.equal(classifyProbe(err(s)), "absent", s);
  assert.deepEqual(parseConfiguredList("claude.ai Gmail"), { names: ["claude.ai Gmail"], truncated: false, more: 0 });
});

test("probe: warnings, mixed streams, unknown shapes, conflicting target and bad truncation are inconclusive", () => {
  const ok = `${prefix}claude.ai Gmail, alpha${more(16)}\n`;
  const inconclusive = [
    { status: null, signal: "SIGTERM", stdout: "", stderr: ok },
    { status: 1, signal: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: ok },
    { status: 1, signal: null, error: { code: "ENOBUFS" }, stdout: "", stderr: ok },
    { status: 2, signal: null, stdout: "", stderr: ok },
    err("network error"),
    err(`No MCP server found with name: "${SERVER_NAME}"`),
    err(`No MCP server named "other-server". Configured servers: x\n`),
    err(`No MCP server named "${SERVER_NAME}x". Configured servers: x\n`),
    err(emptyConfigNotFound(LEGACY_SERVER_NAME)),
    err("", ok),
    err(ok, "warning"),
    err(ok, "\n"),
    err("", ""),
    // mixed warning lines (before/after), missing/extra newline, leading space, CRLF, oversize
    err(`Warning: config migrated\n${ok}`),
    err(`${ok}Warning\n`),
    err(`${ok}\n`),
    err(ok.trimEnd()),
    err(` ${ok}`),
    err(ok.replace("\n", "\r\n")),
    err(ok.replace("\n", "x".repeat(5000) + "\n")),
    err(`${EMPTY_CONFIG_NOT_FOUND}warning\n`),
    // truncation alone, unobserved wordings, or a suffix that is not exact
    err(`${prefix}${more(16).trimStart()}\n`),
    err(`Configured servers: claude.ai Gmail${more(16)}\n`),
    err(`${prefix}\n`),
    err(`${prefix}alpha${more(0)}\n`),
    err(`${prefix}alpha, and 16 more\n`),
    err(`${prefix}alpha and 16 more\n`),
    err(`${prefix}alpha (and many more — run \`claude mcp list\` to see all)\n`),
    err(`${prefix}alpha (and 16 more - run \`claude mcp list\` to see all)\n`),
    err(`${prefix}alpha (and 16 more — run \`claude mcp list\` to see all\n`),
    err(`${prefix}alpha${more(16)}, beta\n`),
    err(`${prefix}alpha${more(16)}${more(2)}\n`),
    err(`${prefix}alpha${more(16)} \n`),
    err(`${prefix}alpha ${more(16)}\n`),
    // conflicting: claims not found but lists the exact target
    err(`${prefix}alpha, ${SERVER_NAME}\n`),
    err(`${prefix}claude.ai Gmail, ${SERVER_NAME}${more(3)}\n`),
    // malformed names / connectors / control characters / duplicates
    err(`${prefix}alpha, alpha\n`),
    err(`${prefix}alpha,beta\n`),
    err(`${prefix}alpha, \n`),
    err(`${prefix}claude.ai  Gmail\n`),
    err(`${prefix}claude.ai Gmail \n`),
    err(`${prefix}claude.ai\n`),
    err(`${prefix}claude.ai "Gmail"\n`),
    err(`${prefix}alpha (project)\n`),
    err(`${prefix}alpha\tbeta\n`),
    err(`${prefix}alpha\u001b[0m\n`),
    err(`${prefix}-alpha\n`),
    err(`${prefix}al.pha\n`),
    err(`${prefix}${"a".repeat(65)}\n`),
  ];
  for (const p of inconclusive) assert.equal(classifyProbe(p), "inconclusive", JSON.stringify(p).slice(0, 160));
  for (const p of [err(`Warning: x\n${OBSERVED_295}`), err(OBSERVED_295.replace("sentinel-03", LEGACY_SERVER_NAME)), err(OBSERVED_295, "x")]) {
    assert.equal(classifyProbe(p, LEGACY_SERVER_NAME), "inconclusive", p.stderr);
  }
});

const goodReadback = (name: string) =>
  [
    `${name}:`,
    "  Scope: User config (available in all your projects)",
    "  Status: ✓ Connected",
    "  Type: stdio",
    "  Command: /n o/node",
    "  Args: /s p/server.js",
    "  Environment:",
    "    CODEX_BIN=/c/codex",
    "    CODEX_IMAGE_OUTPUT_ROOT=/o",
    "",
    `To remove this server, run: claude mcp remove "${name}" -s user`,
    "",
  ].join("\n");

test("readback: exact name, command, args, env and user scope required", () => {
  const exp = { node: "/n o/node", serverJs: "/s p/server.js", env: { CODEX_BIN: "/c/codex", CODEX_IMAGE_OUTPUT_ROOT: "/o" } };
  const good = goodReadback(SERVER_NAME);
  const ok0 = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: "" });
  assert.deepEqual(verifyReadback(ok0(good), exp), []);
  assert.deepEqual(verifyReadback(ok0(goodReadback(LEGACY_SERVER_NAME)), exp, LEGACY_SERVER_NAME), []);
  // The legacy entry never satisfies a canonical readback, and vice versa.
  assert.notDeepEqual(verifyReadback(ok0(goodReadback(LEGACY_SERVER_NAME)), exp), []);
  assert.notDeepEqual(verifyReadback(ok0(good), exp, LEGACY_SERVER_NAME), []);
  const bad = [
    good.replace("User config", "Project config"),
    good.replace("/n o/node", "/other/node"),
    good.replace("  Args: /s p/server.js", "  Args: /s p/server.js --x"),
    good.replace("    CODEX_IMAGE_OUTPUT_ROOT=/o\n", ""),
    good.replace("    CODEX_BIN=/c/codex", "    CODEX_BIN=/c/codex\n    EXTRA=1"),
    good.replace("  Type: stdio", "  Type: http"),
    good.replace(`${SERVER_NAME}:`, "other:"),
    `${good}${LEGACY_SERVER_NAME}:\n`,
    good + "  Command: /n o/node\n",
  ];
  for (const s of bad) assert.notDeepEqual(verifyReadback(ok0(s), exp), [], s);
  assert.notDeepEqual(verifyReadback({ status: 1, signal: null, stdout: good }, exp), []);
  assert.notDeepEqual(verifyReadback({ status: null, signal: "SIGKILL", stdout: good }, exp), []);
});

test("readback: the persisted CODEX_BRIDGE_MODE must match the requested mode exactly (or be absent when not requested)", () => {
  const ok0 = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: "" });
  const env = { CODEX_BIN: "/c/codex", CODEX_IMAGE_OUTPUT_ROOT: "/o" };
  const exp = (mode?: string) => ({ node: "/n o/node", serverJs: "/s p/server.js", env: mode === undefined ? env : { ...env, CODEX_BRIDGE_MODE: mode } });
  const withMode = (line: string) => goodReadback(SERVER_NAME).replace("    CODEX_IMAGE_OUTPUT_ROOT=/o\n", `    CODEX_IMAGE_OUTPUT_ROOT=/o\n${line}`);
  assert.deepEqual(verifyReadback(ok0(withMode("    CODEX_BRIDGE_MODE=image-only\n")), exp("image-only")), []);
  assert.deepEqual(verifyReadback(ok0(withMode("    CODEX_BRIDGE_MODE=general\n")), exp("general")), []);
  const modeProblem = (p: string[]) => p.some((x) => x.startsWith("environment: CODEX_BRIDGE_MODE is not the requested"));
  for (const [stdout, mode] of [
    [goodReadback(SERVER_NAME), "image-only"],
    [withMode("    CODEX_BRIDGE_MODE=general\n"), "image-only"],
    [withMode("    CODEX_BRIDGE_MODE=image-only \n"), "image-only"],
    [withMode("    CODEX_BRIDGE_MODE=image-only\n"), undefined],
    [withMode("    CODEX_BRIDGE_MODE=image-only\n    CODEX_BRIDGE_MODE=image-only\n"), "image-only"],
  ] as const) {
    const p = verifyReadback(ok0(stdout), exp(mode));
    assert.notDeepEqual(p, [], `${mode} ${stdout}`);
    if (!stdout.includes("CODEX_BRIDGE_MODE=image-only\n    CODEX_BRIDGE_MODE")) assert.ok(modeProblem(p), p.join("; "));
  }
});

// --- scripts/register.mjs end to end with fake CLIs ---

interface Fixture {
  dir: string;
  home: string;
  bin: string;
  state: string;
  log: string;
  codex: string;
  claude: string;
}

function fixture(state?: Record<string, unknown>): Fixture {
  const dir = tmpdir();
  const bin = path.join(dir, "My Tools", "bin");
  const f = {
    dir,
    home: path.join(dir, "home"),
    bin,
    state: path.join(dir, "claude-state.json"),
    log: path.join(dir, "claude-log.jsonl"),
    codex: fakeCodex(path.join(bin, "codex"), "codex-cli 9.9.9\n"),
    claude: fakeClaude(path.join(bin, "claude")),
  };
  writeFileSync(f.log, "");
  if (state) writeFileSync(f.state, JSON.stringify(state));
  return f;
}

function register(f: Fixture, args: string[], env: Record<string, string> = {}) {
  // PATH holds only the fake CLIs (no node): the launch env must supply Node.
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "register.mjs"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { HOME: f.home, PATH: f.bin, FAKE_CLAUDE_STATE: f.state, FAKE_CLAUDE_LOG: f.log, ...env },
  });
  const calls = readFileSync(f.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const state = existsSync(f.state) ? (JSON.parse(readFileSync(f.state, "utf8")) as Record<string, any>) : {};
  return { ...r, calls, state };
}

const serverJs = path.join(repo, "dist", "src", "server.js");
const gets = (calls: string[][]) => calls.filter((c) => c[0] === "mcp" && c[1] === "get").map((c) => c[2]);
const mutations = (calls: string[][]) => calls.filter((c) => c[0] === "mcp" && c[1] !== "get");
const user = (command: string) => ({ command, args: [], env: {}, scope: "user" });

test("register: fresh first-ever config, dry run changes nothing; --apply probes both IDs first, then registers the canonical one and verifies readback", () => {
  const f = fixture();
  const dry = register(f, []);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run/);
  assert.match(dry.stdout, /Codex CLI: {3}.*\(9\.9\.9, found via path, node_shebang\)/);
  assert.deepEqual(gets(dry.calls), [SERVER_NAME, LEGACY_SERVER_NAME]);
  assert.deepEqual(mutations(dry.calls), []);
  assert.ok(!existsSync(f.state));

  writeFileSync(f.log, "");
  const r = register(f, ["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Registered and verified "codex-claude-bridge"/);
  const root = path.join(f.home, "codex-images");
  assert.deepEqual(r.state, {
    [SERVER_NAME]: { command: process.execPath, args: [serverJs], env: { CODEX_BIN: f.codex, CODEX_IMAGE_OUTPUT_ROOT: root }, scope: "user" },
  });
  const mcp = r.calls.filter((c) => c[0] === "mcp").map((c) => (c[1] === "get" ? `get ${c[2]}` : c[1]));
  assert.deepEqual(mcp, [`get ${SERVER_NAME}`, `get ${LEGACY_SERVER_NAME}`, "add", `get ${SERVER_NAME}`]);
  assert.deepEqual(mutations(r.calls), [[...head, "-e", `CODEX_BIN=${f.codex}`, "-e", `CODEX_IMAGE_OUTPUT_ROOT=${root}`, "--", process.execPath, serverJs]]);
});

test("register: fake CLI reproduces the exact claude 2.1.295 output for 19 servers; registration succeeds and preserves them", () => {
  const state = Object.fromEntries(sentinels.map((n) => [n, user("/usr/bin/true")]));
  const f = fixture(state);
  const probe = spawnSync(f.claude, ["mcp", "get", LEGACY_SERVER_NAME], {
    encoding: "utf8",
    env: launchEnv({ PATH: f.bin, FAKE_CLAUDE_STATE: f.state, FAKE_CLAUDE_LOG: f.log }),
  });
  assert.deepEqual([probe.status, probe.stdout, probe.stderr], [1, "", OBSERVED_295]);
  const r = register(f, ["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  for (const n of sentinels) assert.deepEqual(r.state[n], state[n]);
  assert.equal(r.state[LEGACY_SERVER_NAME], undefined);
});

test("register: connectors/plugin listing; unrelated registrations and env preserved; explicit paths with spaces", () => {
  const other = { command: "/x/other", args: ["a b"], env: { KEEP: "1" }, scope: "user" };
  const f = fixture({ alpha: other });
  const root = path.join(f.dir, "My Images");
  const r = register(f, ["--apply"], { FAKE_CLAUDE_MODE: "connectors", CODEX_BIN: f.codex, CLAUDE_BIN: f.claude, CODEX_IMAGE_OUTPUT_ROOT: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.alpha, other);
  assert.deepEqual(r.state[SERVER_NAME].env, { CODEX_BIN: f.codex, CODEX_IMAGE_OUTPUT_ROOT: root });
});

test("register: an existing canonical OR legacy registration is never duplicated, overwritten or removed (exit 2)", () => {
  const existing = { command: "/old/node", args: ["/old/server.js"], env: { CODEX_IMAGE_OUTPUT_ROOT: "/keep", EXTRA: "x" }, scope: "user" };
  for (const states of [{ [LEGACY_SERVER_NAME]: existing }, { [SERVER_NAME]: existing }, { [SERVER_NAME]: existing, [LEGACY_SERVER_NAME]: existing }]) {
    const f = fixture(states);
    for (const args of [[], ["--apply"]]) {
      const r = register(f, args);
      assert.equal(r.status, 2, r.stderr);
      assert.deepEqual(r.state, states);
      assert.deepEqual(gets(r.calls), [SERVER_NAME, LEGACY_SERVER_NAME]);
      assert.deepEqual(mutations(r.calls), []);
      for (const n of Object.keys(states)) assert.match(r.stderr, new RegExp(`mcp get ${n}`));
      writeFileSync(f.log, "");
    }
  }
});

test("register: inconclusive probe of either ID is exit 3 with no mutation; failed add or mismatched readback is never success (exit 4)", () => {
  for (const env of [{ FAKE_CLAUDE_MODE: "warn" }, { FAKE_CLAUDE_WARN_NAME: LEGACY_SERVER_NAME }, { FAKE_CLAUDE_WARN_NAME: SERVER_NAME }]) {
    const w = fixture({ alpha: user("/a") });
    const r3 = register(w, ["--apply"], env);
    assert.equal(r3.status, 3, r3.stderr);
    assert.match(r3.stderr, /named_absent_prefix=no/);
    assert.deepEqual(gets(r3.calls), [SERVER_NAME, LEGACY_SERVER_NAME]);
    assert.deepEqual(mutations(r3.calls), []);
    assert.deepEqual(r3.state, { alpha: user("/a") });
  }

  const a = fixture();
  const r4 = register(a, ["--apply"], { FAKE_CLAUDE_MODE: "add_fail" });
  assert.equal(r4.status, 4);
  assert.doesNotMatch(r4.stdout, /Registered/);

  const m = fixture();
  const r5 = register(m, ["--apply"], { FAKE_CLAUDE_MODE: "readback_mismatch" });
  assert.equal(r5.status, 4);
  assert.match(r5.stderr, /NOT confirmed/);
  assert.doesNotMatch(r5.stdout, /Registered/);
  assert.ok(!r5.calls.some((c) => c[1] === "remove"));
});

test("register --check-auth: exit status only, no identity echoed, no MCP calls; missing sign-in prints the official login with exact path and Node PATH", () => {
  const f = fixture();
  const ok = register(f, ["--check-auth"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Codex sign-in: signed in/);
  assert.match(ok.stdout, /Claude sign-in: signed in/);
  assert.doesNotMatch(ok.stdout + ok.stderr, /identity@example/);
  assert.ok(!ok.calls.some((c) => c[0] === "mcp"));
  assert.deepEqual(ok.state, {});

  const out = register(f, ["--check-auth"], { FAKE_CODEX_LOGGED_OUT: "1", FAKE_CLAUDE_LOGGED_OUT: "1" });
  assert.equal(out.status, 5);
  const nodeDir = path.dirname(process.execPath);
  assert.ok(out.stdout.includes(`PATH='${nodeDir}':"$PATH" '${f.codex}' login`), out.stdout);
  assert.ok(out.stdout.includes(`PATH='${nodeDir}':"$PATH" '${f.claude}' auth login`), out.stdout);
  assert.doesNotMatch(out.stdout + out.stderr, /identity@example|Not logged in|loggedIn/);
  assert.ok(!out.calls.some((c) => c[0] === "mcp" || c[0] === "login" || (c[0] === "auth" && c[1] === "login")));

  for (const bad of [["--check-auth", "--apply"], ["--check-auth", "--check-auth"]]) assert.equal(register(f, bad).status, 1);
});

test("register: invalid explicit CODEX_BIN / CLAUDE_BIN fail with no fallback; missing CLIs print official guidance", () => {
  const f = fixture();
  for (const [k, v] of [["CODEX_BIN", ""], ["CODEX_BIN", "codex"], ["CODEX_BIN", path.join(f.dir, "none")], ["CLAUDE_BIN", ""], ["CLAUDE_BIN", f.bin]]) {
    const r = register(f, [], { [k!]: v! });
    assert.equal(r.status, 1, `${k}=${v}`);
    assert.match(r.stderr, new RegExp(`${k} is set but .*not falling back`));
  }
  const bad = fixture();
  fakeCodex(bad.codex, "codex-cli something\n");
  const r = register(bad, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected version line[\s\S]*npm install -g @openai\/codex/);
  assert.ok(!r.calls.some((c) => c[0] === "mcp"), "nothing probed or registered");
  assert.equal(register(f, ["--force"]).status, 1);
});

test("register: CODEX_BRIDGE_MODE=image-only dry run shows the mode and its limitation; --apply persists it and verifies readback", () => {
  const f = fixture();
  const dry = register(f, [], { CODEX_BRIDGE_MODE: "image-only" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Bridge mode \(env\): image-only \(stored as CODEX_BRIDGE_MODE=image-only\)/);
  assert.match(dry.stdout, /MCP tool list and refuses direct calls to it \(TOOL_DISABLED\)/);
  assert.match(dry.stdout, /It is NOT a sandbox: native Codex capabilities are unchanged/);
  assert.ok(dry.stdout.includes('"-e" "CODEX_BRIDGE_MODE=image-only" "--"'), dry.stdout);
  assert.deepEqual(gets(dry.calls), [SERVER_NAME, LEGACY_SERVER_NAME]);
  assert.deepEqual(mutations(dry.calls), []);
  assert.ok(!existsSync(f.state));

  writeFileSync(f.log, "");
  const r = register(f, ["--apply"], { CODEX_BRIDGE_MODE: "image-only" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Registered and verified "codex-claude-bridge" \(user scope, bridge mode image-only\)/);
  const root = path.join(f.home, "codex-images");
  const env = { CODEX_BIN: f.codex, CODEX_IMAGE_OUTPUT_ROOT: root, CODEX_BRIDGE_MODE: "image-only" };
  assert.deepEqual(r.state, { [SERVER_NAME]: { command: process.execPath, args: [serverJs], env, scope: "user" } });
  assert.deepEqual(mutations(r.calls), [
    [...head, "-e", `CODEX_BIN=${f.codex}`, "-e", `CODEX_IMAGE_OUTPUT_ROOT=${root}`, "-e", "CODEX_BRIDGE_MODE=image-only", "--", process.execPath, serverJs],
  ]);
});

test("register: explicit general is persisted; unset reports the default and stores no mode", () => {
  const g = fixture();
  const r = register(g, ["--apply"], { CODEX_BRIDGE_MODE: "general" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state[SERVER_NAME].env.CODEX_BRIDGE_MODE, "general");
  assert.doesNotMatch(r.stdout, /NOT a sandbox/);

  const u = fixture();
  const dry = register(u, []);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Bridge mode \(default\): general \(CODEX_BRIDGE_MODE not set, so not stored\)/);
  assert.doesNotMatch(dry.stdout, /CODEX_BRIDGE_MODE=/);
});

test("register: invalid CODEX_BRIDGE_MODE fails (exit 1) before discovery, probing or any mutation; the value is never echoed", () => {
  for (const bad of INVALID_MODES) {
    const f = fixture();
    for (const args of [[], ["--apply"], ["--check-auth"]]) {
      const r = register(f, args, { CODEX_BRIDGE_MODE: bad });
      assert.equal(r.status, 1, JSON.stringify(bad));
      assert.equal(r.stderr, `${BRIDGE_MODE_INVALID_MESSAGE}; not registering.\n`);
      assert.equal(r.stdout, "");
      assert.deepEqual(r.calls, [], "claude was never run");
      assert.ok(!existsSync(f.state));
    }
  }
});

test("register: a mode never updates an existing canonical or legacy registration (exit 2, unchanged)", () => {
  const existing = { command: "/old/node", args: ["/old/server.js"], env: { CODEX_IMAGE_OUTPUT_ROOT: "/keep", EXTRA: "x" }, scope: "user" };
  for (const states of [{ [LEGACY_SERVER_NAME]: existing }, { [SERVER_NAME]: existing }]) {
    const f = fixture(states);
    const r = register(f, ["--apply"], { CODEX_BRIDGE_MODE: "image-only" });
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(r.state, states);
    assert.deepEqual(mutations(r.calls), []);
    assert.match(r.stderr, /docs\/image-only\.md/);
  }
});

test("register: a persisted mode that reads back differently is never success (exit 4); nothing is removed", () => {
  const f = fixture();
  // Wrapper around the fake CLI that changes the stored mode right after `mcp add`.
  const real = fakeClaude(path.join(f.dir, "real-claude"));
  writeExec(
    f.claude,
    nodeScript(`
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const a = process.argv.slice(2);
const r = spawnSync(${JSON.stringify(real)}, a, { stdio: "inherit" });
if (a[0] === "mcp" && a[1] === "add" && r.status === 0) {
  const st = process.env.FAKE_CLAUDE_STATE;
  const s = JSON.parse(fs.readFileSync(st, "utf8"));
  for (const e of Object.values(s)) if (e.env.CODEX_BRIDGE_MODE) e.env.CODEX_BRIDGE_MODE = "general";
  fs.writeFileSync(st, JSON.stringify(s));
}
process.exit(r.status === null ? 1 : r.status);`),
  );
  const r = register(f, ["--apply"], { CODEX_BRIDGE_MODE: "image-only" });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /NOT confirmed/);
  assert.match(r.stderr, /CODEX_BRIDGE_MODE is not the requested image-only/);
  assert.doesNotMatch(r.stdout, /Registered/);
  assert.ok(!r.calls.some((c) => c[1] === "remove"));
  assert.equal(r.state[SERVER_NAME].env.CODEX_BRIDGE_MODE, "general", "left as the CLI stored it");
});

test("register --check-auth: an invalid mode fails (exit 1, no calls); a valid mode only checks sign-in and never touches MCP config", () => {
  const f = fixture();
  const bad = register(f, ["--check-auth"], { CODEX_BRIDGE_MODE: "SECRET-mode" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `${BRIDGE_MODE_INVALID_MESSAGE}; not registering.\n`);
  assert.deepEqual(bad.calls, []);
  assert.doesNotMatch(bad.stdout + bad.stderr, /SECRET/);
  assert.ok(!existsSync(f.state));
  for (const mode of ["general", "image-only"]) {
    const r = register(f, ["--check-auth"], { CODEX_BRIDGE_MODE: mode });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.calls.some((c) => c[0] === "mcp"));
    assert.ok(!existsSync(f.state));
  }
});
