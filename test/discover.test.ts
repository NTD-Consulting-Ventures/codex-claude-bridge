// NON-LIVE: discovery and launch environment against temporary fixture
// executables; no real codex, claude or npm is run.

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  checkClaudeVersion,
  checkCodexVersion,
  discoverExecutable,
  parseNpmPrefix,
  pathDirs,
  spawnRunner,
  wellKnownDirs,
  type DiscoverDeps,
  type RunResult,
  type Runner,
} from "../src/discover.js";
import { checkExecutable, currentNodeDir, launcherKind, launcherStatus, launchEnv, NODE_SHEBANG } from "../src/launch.js";
import { resolveCodexBin, spawnAppServer } from "../src/process-transport.js";
import { versionProbeFor } from "../src/status.js";
import { fakeCodex, fakeNpm, nodeScript, tmpdir, writeExec } from "./fake-cli.js";

const okRun = (stdout: string): RunResult => ({ status: 0, signal: null, stdout, stderr: "" });

function deps(over: Partial<DiscoverDeps> & { calls?: string[][] } = {}): DiscoverDeps {
  const calls = over.calls ?? [];
  const run: Runner = (file, args) => (calls.push([file, ...args]), okRun(""));
  // A fake execPath keeps the real npm next to the test's Node out of reach.
  return { env: {}, platform: "linux", home: "/nonexistent-home", execPath: "/nonexistent/node", run, wellKnown: [], ...over };
}

test("checkExecutable: explicit paths must be absolute normalized executable regular files; spaces and symlinks fine", () => {
  const d = tmpdir();
  const exe = writeExec(path.join(d, "My Tools", "codex"), "#!/bin/sh\n");
  const plain = writeExec(path.join(d, "plain"), "x", 0o644);
  mkdirSync(path.join(d, "dir"));
  symlinkSync(exe, path.join(d, "link"));
  assert.deepEqual(checkExecutable(exe), { ok: true, path: exe, real: exe });
  assert.deepEqual(checkExecutable(path.join(d, "link")), { ok: true, path: path.join(d, "link"), real: exe });
  const bad: [string, string][] = [
    ["", "empty"],
    ["codex", "relative"],
    ["./codex", "relative"],
    [`${d}/My Tools/../My Tools/codex`, "not_normalized"],
    [`${d}//plain`, "not_normalized"],
    [`${exe}/`, "not_normalized"],
    [`${d}/a\0b`, "nul_byte"],
    [path.join(d, "missing"), "missing"],
    [path.join(d, "dir"), "not_file"],
    [plain, "not_executable"],
  ];
  for (const [raw, reason] of bad) assert.deepEqual(checkExecutable(raw), { ok: false, reason }, JSON.stringify(raw));
});

test("explicit CODEX_BIN / CLAUDE_BIN: valid wins; empty/invalid/missing/non-executable fails with NO fallback", () => {
  const d = tmpdir();
  const onPath = writeExec(path.join(d, "bin", "codex"), "#!/bin/sh\n");
  const explicit = writeExec(path.join(d, "explicit dir", "codex"), "#!/bin/sh\n");
  const env = { PATH: path.join(d, "bin") };
  assert.deepEqual(discoverExecutable("codex", "CODEX_BIN", deps({ env: { ...env, CODEX_BIN: explicit } })), { ok: true, path: explicit, source: "env" });
  for (const bad of ["", "codex", "/a/../codex", path.join(d, "nope"), path.join(d, "bin"), writeExec(path.join(d, "noexec"), "x", 0o600), "/a\0b"]) {
    const calls: string[][] = [];
    const r = discoverExecutable("codex", "CODEX_BIN", deps({ env: { ...env, CODEX_BIN: bad }, calls }));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match((r as { reason: string }).reason, /CODEX_BIN is set but .*not falling back/);
    assert.equal(calls.length, 0, "no npm probe");
  }
  assert.equal(discoverExecutable("claude", "CLAUDE_BIN", deps({ env: { ...env, CLAUDE_BIN: "" } })).ok, false);
  assert.deepEqual(discoverExecutable("codex", "CODEX_BIN", deps({ env })), { ok: true, path: onPath, source: "path" });
});

test("PATH: absolute directories in order; empty, relative, missing and non-executable entries skipped", () => {
  const d = tmpdir();
  writeExec(path.join(d, "first", "codex"), "x", 0o644); // not executable: skipped
  mkdirSync(path.join(d, "second", "codex"), { recursive: true }); // directory: skipped
  const third = writeExec(path.join(d, "third dir", "codex"), "#!/bin/sh\n");
  writeExec(path.join(d, "fourth", "codex"), "#!/bin/sh\n");
  writeExec(path.join(d, "rel", "codex"), "#!/bin/sh\n");
  const PATH = ["", "rel", "./rel", path.join(d, "first"), path.join(d, "second"), path.join(d, "missing"), path.join(d, "third dir"), path.join(d, "fourth")].join(":");
  assert.deepEqual(pathDirs({ PATH }), [path.join(d, "first"), path.join(d, "second"), path.join(d, "missing"), path.join(d, "third dir"), path.join(d, "fourth")]);
  assert.deepEqual(discoverExecutable("codex", "CODEX_BIN", deps({ env: { PATH } })), { ok: true, path: third, source: "path" });
  // Minimal / empty PATH: nothing found there.
  assert.deepEqual(pathDirs({}), []);
  assert.deepEqual(pathDirs({ PATH: "" }), []);
});

test("well-known directories: ~/.local/bin, Homebrew only on darwin, /usr/local/bin; used after PATH", () => {
  assert.deepEqual(wellKnownDirs("/Users/example-user", "darwin"), ["/Users/example-user/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  assert.deepEqual(wellKnownDirs("/home/example-user", "linux"), ["/home/example-user/.local/bin", "/usr/local/bin"]);
  assert.deepEqual(wellKnownDirs("relative", "linux"), ["/usr/local/bin"]);
  const d = tmpdir();
  const local = writeExec(path.join(d, "home", ".local", "bin", "claude"), "#!/bin/sh\n");
  const brew = writeExec(path.join(d, "brew", "claude"), "#!/bin/sh\n");
  const wk = [path.join(d, "home", ".local", "bin"), path.join(d, "brew")];
  assert.deepEqual(discoverExecutable("claude", "CLAUDE_BIN", deps({ wellKnown: wk })), { ok: true, path: local, source: "well_known" });
  assert.deepEqual(discoverExecutable("claude", "CLAUDE_BIN", deps({ wellKnown: wk.slice(1) })), { ok: true, path: brew, source: "well_known" });
  const onPath = writeExec(path.join(d, "p", "claude"), "#!/bin/sh\n");
  assert.deepEqual(discoverExecutable("claude", "CLAUDE_BIN", deps({ wellKnown: wk, env: { PATH: path.join(d, "p") } })), { ok: true, path: onPath, source: "path" });
});

test("npm prefix: legitimately discovered npm, bounded, validated output; failures are diagnosed, never guessed", () => {
  const d = tmpdir();
  const npm = writeExec(path.join(d, "npmdir", "npm"), "#!/bin/sh\n");
  const codex = writeExec(path.join(d, "prefix dir", "bin", "codex"), "#!/bin/sh\n");
  const env = { PATH: path.join(d, "npmdir") };
  const calls: string[][] = [];
  const seen: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = (file, args, o) => (calls.push([file, ...args]), seen.push(o), okRun(`${path.join(d, "prefix dir")}\n`));
  assert.deepEqual(discoverExecutable("codex", "CODEX_BIN", deps({ env, run })), { ok: true, path: codex, source: "npm_prefix" });
  assert.deepEqual(calls, [[npm, "prefix", "-g"]]);
  assert.ok(seen[0]!.timeoutMs > 0 && seen[0]!.timeoutMs <= 15_000 && seen[0]!.maxBuffer <= 64 * 1024);
  assert.equal(seen[0]!.env.npm_config_update_notifier, "false");
  const bad: RunResult[] = [
    { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "" },
    { status: null, signal: null, error: { code: "ENOBUFS" }, stdout: "" },
    { status: 1, signal: null, stdout: `${d}\n` },
    { status: null, signal: "SIGTERM", stdout: `${d}\n` },
    okRun(""),
    okRun("\n"),
    okRun("relative/prefix\n"),
    okRun(`${d}/a/../b\n`),
    okRun(`${d}\n${d}\n`),
    okRun(`${d}\r\n`),
    okRun(`npm WARN x\n${d}\n`),
  ];
  for (const r of bad) {
    const res = discoverExecutable("codex", "CODEX_BIN", deps({ env, run: () => r }));
    assert.equal(res.ok, false, JSON.stringify(r));
    assert.match((res as { reason: string }).reason, /npm global prefix \(.*prefix -g/);
  }
  const none = discoverExecutable("codex", "CODEX_BIN", deps());
  assert.match((none as { reason: string }).reason, /npm not found/);
  assert.equal(parseNpmPrefix(`/usr/local\n`), "/usr/local");
  assert.equal(parseNpmPrefix(`/opt/My Prefix`), "/opt/My Prefix");
  assert.equal(parseNpmPrefix(null), null);
});

test("version checks: bounded, exit status and output shape validated", () => {
  const seen: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv }[] = [];
  const with1 = (r: RunResult): DiscoverDeps => deps({ run: (_f, _a, o) => (seen.push(o), r) });
  assert.deepEqual(checkCodexVersion("/x/codex", with1(okRun("codex-cli 0.162.1\n"))), { ok: true, version: "0.162.1" });
  assert.equal(seen[0]!.maxBuffer, 4096);
  assert.equal(seen[0]!.env.HOME, undefined, "codex --version gets the minimal probe env");
  assert.deepEqual(checkClaudeVersion("/x/claude", with1(okRun("2.1.295 (Claude Code)\n"))), { ok: true, version: "2.1.295" });
  for (const r of [
    okRun("codex-cli 0.162.1 extra\n"),
    okRun(""),
    okRun("codex-cli 0.162.1\nmore\n"),
    { status: 1, signal: null, stdout: "codex-cli 0.162.1\n" },
    { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "" },
  ]) {
    assert.equal(checkCodexVersion("/x/codex", with1(r)).ok, false, JSON.stringify(r));
  }
  assert.equal(checkClaudeVersion("/x/claude", with1(okRun("claude 2.1.295\n"))).ok, false);
  assert.equal(checkClaudeVersion("/x/claude", with1({ status: 2, signal: null, stdout: "2.1.295 (Claude Code)\n" })).ok, false);
});

test("launcherKind recognizes only the exact npm node shebang; native magic; others are scripts/unknown", () => {
  const d = tmpdir();
  assert.equal(launcherKind(writeExec(path.join(d, "a"), `${NODE_SHEBANG}\nrequire("x")\n`)), "node_shebang");
  assert.equal(launcherKind(writeExec(path.join(d, "b"), "#!/usr/bin/env  node\n")), "other_script");
  assert.equal(launcherKind(writeExec(path.join(d, "c"), "#!/usr/bin/env node --flag\n")), "other_script");
  assert.equal(launcherKind(writeExec(path.join(d, "d"), "#!/bin/sh\n")), "other_script");
  assert.equal(launcherKind(writeExec(path.join(d, "e"), `#!${"x".repeat(300)}\n`)), "other_script");
  const macho = path.join(d, "f");
  writeFileSync(macho, Buffer.from("cffaedfe07000001", "hex"));
  assert.equal(launcherKind(macho), "native");
  assert.equal(launcherKind(writeExec(path.join(d, "g"), "plain")), "unknown");
  assert.equal(launcherKind(path.join(d, "missing")), "unknown");
  symlinkSync(path.join(d, "a"), path.join(d, "link"));
  assert.equal(launcherKind(path.join(d, "link")), "node_shebang");
});

test("launchEnv: verified current Node directory first on PATH; rest of env preserved; unverifiable Node leaves env unchanged", () => {
  const n = currentNodeDir();
  assert.ok(n.verified, "test Node has a sibling node");
  const base = { PATH: `/usr/bin::${n.dir}:/bin`, HOME: "/h", CODEX_HOME: "/c" };
  const env = launchEnv(base);
  assert.equal(env.PATH, `${n.dir}:/usr/bin:/bin`);
  assert.equal(env.HOME, "/h");
  assert.equal(env.CODEX_HOME, "/c");
  assert.equal(base.PATH, `/usr/bin::${n.dir}:/bin`, "input not mutated");
  assert.equal(launchEnv({}).PATH, n.dir);
  assert.equal(launchEnv({ PATH: "" }).PATH, n.dir);
  // A Node directory whose `node` is a different file is not trusted.
  const d = tmpdir();
  const fakeNode = writeExec(path.join(d, "node"), "#!/bin/sh\n");
  writeExec(path.join(d, "other", "node"), "#!/bin/sh\n");
  assert.equal(currentNodeDir(fakeNode).verified, true);
  assert.deepEqual(launchEnv({ PATH: "/usr/bin" }, path.join(d, "other", "node22")), { PATH: "/usr/bin" });
  assert.deepEqual(launchEnv({ PATH: "/usr/bin" }, "relative/node"), { PATH: "/usr/bin" });
});

test("runtime: explicit empty CODEX_BIN now fails closed; unset keeps ~/.local/bin/codex; no PATH/npm discovery", () => {
  assert.deepEqual(resolveCodexBin({ CODEX_BIN: "" }), { path: null, source: "env" });
  assert.equal(resolveCodexBin({}).source, "default");
  assert.match(resolveCodexBin({ PATH: "/opt/homebrew/bin" }).path!, /\/\.local\/bin\/codex$/);
  assert.equal(launcherStatus(resolveCodexBin({ CODEX_BIN: "" })).codex_launcher, "invalid");
});

test("npm-style Codex symlink launcher with a minimal PATH (no node): version probe, status and app-server all start it", async () => {
  const d = tmpdir();
  const js = fakeCodex(path.join(d, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "codex-cli 9.9.9\n");
  const link = path.join(d, "My Prefix", "bin", "codex");
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(js, link);
  // Spawned directly with the probe's minimal env plus the verified Node dir.
  const v = await versionProbeFor({ CODEX_BIN: link })();
  assert.deepEqual(v, { ok: true, stdout: "codex-cli 9.9.9\n" });
  const st = launcherStatus(resolveCodexBin({ CODEX_BIN: link }));
  assert.equal(st.codex_launcher, "node_shebang");
  assert.equal(st.node_path, process.execPath);
  assert.equal(st.node_version, process.version);
  assert.equal(st.node_dir_on_child_path, true);
  // App-server: exact unchanged args, the symlink entry is spawned, node comes from the controlled PATH.
  const t = spawnAppServer({ bin: link, cwd: d, baseEnv: { PATH: "/usr/bin:/bin" } });
  const out = await new Promise<string>((resolve) => {
    let buf = "";
    t.onStdout((c) => {
      buf += c;
      if (buf.includes("\n")) resolve(buf);
    });
  });
  t.close();
  const parsed = JSON.parse(out) as { argv: string[]; node: string };
  assert.deepEqual(parsed.argv, ["app-server", "--listen", "stdio://"]);
  assert.equal(path.dirname(parsed.node), currentNodeDir().dir);
});

test("spawnRunner runs a fake npm launcher with an empty PATH via the shared launch env", () => {
  const d = tmpdir();
  const prefix = path.join(d, "global prefix");
  const npm = fakeNpm(path.join(d, "node dir", "npm"), `${prefix}\n`);
  const codex = writeExec(path.join(prefix, "bin", "codex"), nodeScript(""));
  const r = discoverExecutable("codex", "CODEX_BIN", { env: { PATH: path.dirname(npm) }, platform: "linux", home: d, execPath: process.execPath, run: spawnRunner, wellKnown: [] });
  assert.deepEqual(r, { ok: true, path: codex, source: "npm_prefix" });
});
