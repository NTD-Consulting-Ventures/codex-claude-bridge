// NON-LIVE: shared output-root resolver, pre-write root checks and version sync.

import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveRegisteredOutputRoot } from "../src/install.js";
import { resolveOutputRoot } from "../src/output-root.js";
import { PathSecurityError, prepareOwnedRoot } from "../src/paths.js";
import { SERVER_VERSION } from "../src/status.js";

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-")));

test("absent CODEX_IMAGE_OUTPUT_ROOT resolves to ~/codex-images (runtime and installer agree)", () => {
  assert.deepEqual(resolveOutputRoot({}), { ok: true, path: path.join(os.homedir(), "codex-images"), source: "default" });
  assert.deepEqual(resolveOutputRoot({}, () => "/Users/u"), { ok: true, path: "/Users/u/codex-images", source: "default" });
  assert.deepEqual(resolveRegisteredOutputRoot({}, () => "/Users/u"), { ok: true, path: "/Users/u/codex-images", source: "default" });
  assert.deepEqual(resolveRegisteredOutputRoot({}), { ok: true, path: path.join(os.homedir(), "codex-images"), source: "default" });
});

test("valid override is used as-is by runtime and installer", () => {
  for (const p of ["/Users/u/img", "/Users/u/My Images", "/a"]) {
    assert.deepEqual(resolveOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: p }), { ok: true, path: p, source: "env" });
    assert.deepEqual(resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: p }), { ok: true, path: p, source: "env" });
  }
});

test("explicit invalid values fail with a typed, sanitized error and never fall back to the default", () => {
  const cases: [string, string][] = [
    ["", "empty"],
    ["SECRET", "relative"],
    ["./SECRET", "relative"],
    ["~/SECRET", "relative"],
    ["/a/../SECRET", "not_normalized"],
    ["/a//SECRET", "not_normalized"],
    ["/a/./SECRET", "not_normalized"],
    ["/SECRET/", "not_normalized"],
    ["/", "filesystem_root"],
    ["/SECRET\0x", "nul_byte"],
  ];
  for (const [raw, reason] of cases) {
    const r = resolveOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: raw });
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (r.ok) continue;
    assert.equal(r.reason, reason, JSON.stringify(raw));
    assert.equal(r.source, "env");
    assert.ok(!r.message.includes("SECRET"), "message never echoes the value");
    assert.match(r.message, /CODEX_IMAGE_OUTPUT_ROOT/);
    const i = resolveRegisteredOutputRoot({ CODEX_IMAGE_OUTPUT_ROOT: raw });
    assert.deepEqual(i, { ok: false, reason: r.message });
  }
});

test("unusable home directory is a typed error, not a guessed default", () => {
  for (const home of ["", "relative", "/"]) {
    const r = resolveOutputRoot({}, () => home);
    assert.equal(r.ok, false, home);
    assert.equal(!r.ok && r.reason, "home_unavailable");
  }
  assert.equal(resolveOutputRoot({}, () => { throw new Error("no home"); }).ok, false);
});

test("prepareOwnedRoot creates a missing root 0700 and accepts an existing owned one", async () => {
  const base = tmp();
  const root = path.join(base, "a", "codex-images");
  await prepareOwnedRoot(root);
  assert.ok(lstatSync(root).isDirectory());
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  await prepareOwnedRoot(root);
});

test("prepareOwnedRoot rejects symlink roots/ancestors BEFORE creating anything, and non-directories", async () => {
  const base = tmp();
  const target = path.join(base, "target");
  mkdirSync(target);
  symlinkSync(target, path.join(base, "link"));
  for (const root of [path.join(base, "link"), path.join(base, "link", "new"), path.join(base, "link", "new", "deeper")]) {
    await assert.rejects(prepareOwnedRoot(root), PathSecurityError, root);
  }
  assert.deepEqual(readdirSync(target), [], "no directory created through the symlink");
  writeFileSync(path.join(base, "file"), "x");
  await assert.rejects(prepareOwnedRoot(path.join(base, "file")), PathSecurityError);
  await assert.rejects(prepareOwnedRoot(path.join(base, "file", "sub")), PathSecurityError);
  for (const bad of ["/", "rel", "/a/../b", "/a\0b"]) await assert.rejects(prepareOwnedRoot(bad), PathSecurityError, bad);
});

test("version 0.2.2 is synchronized across package.json, package-lock.json and SERVER_VERSION; names kept", () => {
  // Compiled to dist/test/*.js, so the repo root is two levels up.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(SERVER_VERSION, "0.2.2");
  assert.equal(pkg.version, "0.2.2");
  assert.equal(lock.version, "0.2.2");
  assert.equal(lock.packages[""].version, "0.2.2");
  assert.equal(pkg.name, "codex-claude-bridge");
  assert.equal(lock.name, "codex-claude-bridge");
  assert.deepEqual(pkg.bin, { "codex-claude-bridge": "dist/src/server.js", "codex-image-mcp": "dist/src/server.js" });
  assert.deepEqual(lock.packages[""].bin, pkg.bin);
});
