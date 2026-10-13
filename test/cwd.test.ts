// NON-LIVE: validateCwd against temp directories only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CwdError, assertCwdShape, validateCwd } from "../src/cwd.js";

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-cwd-")));

async function rejects(cwd: unknown, reason: string): Promise<void> {
  await assert.rejects(validateCwd(cwd), (e: unknown) => {
    assert.ok(e instanceof CwdError, String(cwd));
    assert.equal(e.reason, reason, String(cwd));
    return true;
  });
}

test("accepts an explicit canonical absolute existing directory and returns it unchanged", async () => {
  const d = tmp();
  assert.equal(await validateCwd(d), d);
});

test("rejects root, home and ancestors of home as too broad", async () => {
  await rejects("/", "too broad");
  await rejects(os.homedir(), "too broad");
  const parent = path.dirname(os.homedir());
  if (parent !== "/") await rejects(parent, "too broad");
});

test("shape check: home subdirectories and prefix-sharing siblings of home are not too broad", () => {
  const home = os.homedir();
  assert.equal(assertCwdShape(path.join(home, "project")), path.join(home, "project"));
  assert.equal(assertCwdShape(`${home}-sibling`), `${home}-sibling`);
  for (const broad of ["/", home, path.dirname(home)]) {
    assert.throws(() => assertCwdShape(broad), (e: unknown) => e instanceof CwdError && e.reason === "too broad");
  }
});

test("rejects a symlinked directory and a path traversing a symlinked component", async () => {
  const base = tmp();
  const real = path.join(base, "real");
  mkdirSync(path.join(real, "inner"), { recursive: true });
  const link = path.join(base, "link");
  symlinkSync(real, link);
  await rejects(link, "must not traverse symlinks");
  await rejects(path.join(link, "inner"), "must not traverse symlinks");
});

test("rejects missing paths, files, relative, non-normalized and malformed input", async () => {
  const base = tmp();
  const file = path.join(base, "f.txt");
  writeFileSync(file, "x");
  await rejects(path.join(base, "missing"), "does not exist");
  await rejects(file, "not a directory");
  await rejects("relative/dir", "must be absolute");
  await rejects(`${base}/../${path.basename(base)}`, "must be normalized");
  await rejects(`${base}/`, "must be normalized");
  await rejects(`${base}//x`, "must be normalized");
  for (const bad of [undefined, null, 5, "", "a\0b", "/" + "a".repeat(5000)]) await rejects(bad, "invalid");
});
