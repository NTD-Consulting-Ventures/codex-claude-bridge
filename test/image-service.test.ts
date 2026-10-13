// NON-LIVE: collection against temp-dir fixtures only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectImages, ImageError } from "../src/image-service.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

test("partial collection failure (valid then invalid source) removes only the owned dir", async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-")));
  const home = path.join(base, "codex-home");
  mkdirSync(path.join(home, "generated_images"), { recursive: true });
  const good = path.join(home, "generated_images", "a.png");
  const bad = path.join(home, "generated_images", "b.png");
  writeFileSync(good, PNG);
  writeFileSync(bad, "not an image");
  const out = path.join(base, "out");
  mkdirSync(out);
  writeFileSync(path.join(out, "sentinel.txt"), "keep");
  let owned = 0;
  await assert.rejects(
    collectImages([good, bad], out, [home], { own: () => void owned++ }),
    (e: unknown) => e instanceof ImageError && e.code === "IMAGE_VERIFICATION_FAILED",
  );
  assert.equal(owned, 1);
  assert.deepEqual(readdirSync(out), ["sentinel.txt"]);
  assert.equal(readFileSync(path.join(out, "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(readFileSync(good), PNG);
  assert.equal(readFileSync(bad, "utf8"), "not an image");
});
