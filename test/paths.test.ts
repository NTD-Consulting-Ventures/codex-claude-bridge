import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PathSecurityError,
  copyVerifiedInputImage,
  detectImageType,
  readVerifiedInputImage,
  reserveOutput,
  sha256,
  verifyOwnedOutput,
} from "../src/paths.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-png")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fixture-jpeg"), Buffer.from([0xff, 0xd9])]);

async function tmp(): Promise<string> {
  // realpath: on macOS os.tmpdir() lives under the /var -> /private/var symlink.
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "cim-paths-")));
}

function rejected(reason?: string) {
  return (e: unknown) => e instanceof PathSecurityError && (reason === undefined || e.reason === reason);
}

test("signatures: PNG and JPEG detected, others rejected", () => {
  assert.equal(detectImageType(PNG), "png");
  assert.equal(detectImageType(JPEG), "jpeg");
  assert.equal(detectImageType(Buffer.from("GIF89a")), null);
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), null);
  assert.equal(detectImageType(PNG.subarray(0, 7)), null);
});

test("reads a regular PNG inside root and hashes it", async () => {
  const root = await tmp();
  const f = path.join(root, "a.png");
  await fsp.writeFile(f, PNG);
  const img = await readVerifiedInputImage(f, [root]);
  assert.equal(img.type, "png");
  assert.equal(img.sha256, sha256(PNG));
});

test("rejects relative, unnormalized, NUL and outside-root paths", async () => {
  const root = await tmp();
  const other = await tmp();
  const f = path.join(other, "a.png");
  await fsp.writeFile(f, PNG);
  await assert.rejects(readVerifiedInputImage("a.png", [root]), rejected("path must be absolute"));
  await assert.rejects(readVerifiedInputImage(`${root}/../${path.basename(other)}/a.png`, [root]), rejected("path must be normalized"));
  await assert.rejects(readVerifiedInputImage(`${root}/a\0.png`, [root]), rejected("invalid path"));
  await assert.rejects(readVerifiedInputImage(f, [root]), rejected("outside allowed roots"));
  await assert.rejects(readVerifiedInputImage(root, [root]), rejected("outside allowed roots"));
  await assert.rejects(readVerifiedInputImage(f, ["relative/root"]), rejected("root must be absolute"));
  await assert.rejects(readVerifiedInputImage(f, []), rejected());
});

test("rejects sibling-prefix escape (/root-evil vs /root)", async () => {
  const base = await tmp();
  const root = path.join(base, "root");
  const evil = path.join(base, "root-evil");
  await fsp.mkdir(root);
  await fsp.mkdir(evil);
  await fsp.writeFile(path.join(evil, "a.png"), PNG);
  await assert.rejects(readVerifiedInputImage(path.join(evil, "a.png"), [root]), rejected("outside allowed roots"));
});

test("rejects symlinked file and symlinked directory component", async () => {
  const root = await tmp();
  const outside = await tmp();
  await fsp.writeFile(path.join(outside, "secret.png"), PNG);
  await fsp.symlink(path.join(outside, "secret.png"), path.join(root, "link.png"));
  await assert.rejects(readVerifiedInputImage(path.join(root, "link.png"), [root]), rejected("symlink in path"));
  await fsp.symlink(outside, path.join(root, "dir"));
  await assert.rejects(readVerifiedInputImage(path.join(root, "dir", "secret.png"), [root]), rejected("symlink in path"));
});

test("rejects symlinked root itself", async () => {
  const real = await tmp();
  const base = await tmp();
  await fsp.writeFile(path.join(real, "a.png"), PNG);
  const linkRoot = path.join(base, "lr");
  await fsp.symlink(real, linkRoot);
  await assert.rejects(readVerifiedInputImage(path.join(linkRoot, "a.png"), [linkRoot]), rejected("symlink in path"));
});

test("rejects directories, non-images, hard links and oversize", async () => {
  const root = await tmp();
  await fsp.mkdir(path.join(root, "d.png"));
  await assert.rejects(readVerifiedInputImage(path.join(root, "d.png"), [root]), rejected("not a regular file"));
  await fsp.writeFile(path.join(root, "t.png"), "not an image");
  await assert.rejects(readVerifiedInputImage(path.join(root, "t.png"), [root]), rejected("not a PNG or JPEG image"));
  await fsp.writeFile(path.join(root, "h.png"), PNG);
  await fsp.link(path.join(root, "h.png"), path.join(root, "h2.png"));
  await assert.rejects(readVerifiedInputImage(path.join(root, "h.png"), [root]), rejected("hard-linked file"));
  await fsp.writeFile(path.join(root, "big.png"), PNG);
  await assert.rejects(readVerifiedInputImage(path.join(root, "big.png"), [root], 4), rejected("file too large"));
});

test("TOCTOU: file swapped for a symlink after validation is caught", async () => {
  const root = await tmp();
  const outside = await tmp();
  const f = path.join(root, "a.png");
  await fsp.writeFile(f, PNG);
  await fsp.writeFile(path.join(outside, "s.png"), JPEG);
  // Swap between the initial lstat walk and open by racing many attempts.
  let caught = 0;
  for (let i = 0; i < 20; i++) {
    await fsp.rm(f, { force: true });
    await fsp.writeFile(f, PNG);
    const read = readVerifiedInputImage(f, [root]).then(
      (img) => ({ img, err: undefined }),
      (err: unknown) => ({ img: undefined, err }),
    );
    await fsp.rm(f, { force: true });
    await fsp.symlink(path.join(outside, "s.png"), f);
    const { img, err } = await read;
    if (img) {
      // If the read won the race it must be the original bytes, never the outside file.
      assert.equal(img.sha256, sha256(PNG));
    } else {
      assert.ok(err instanceof PathSecurityError);
      caught++;
    }
  }
  assert.ok(caught > 0, "expected at least one swap to be rejected");
});

test("copy writes UUID-named 0600 file and never overwrites", async () => {
  const root = await tmp();
  const dest = await tmp();
  await fsp.writeFile(path.join(root, "a.jpg"), JPEG);
  const c = await copyVerifiedInputImage(path.join(root, "a.jpg"), [root], dest);
  assert.match(path.basename(c.path), /^[0-9a-f-]{36}\.jpg$/);
  assert.equal((await fsp.stat(c.path)).mode & 0o777, 0o600);
  assert.equal(sha256(await fsp.readFile(c.path)), sha256(JPEG));
});

test("copy refuses symlinked destination dir", async () => {
  const root = await tmp();
  const dest = await tmp();
  const base = await tmp();
  await fsp.writeFile(path.join(root, "a.png"), PNG);
  await fsp.symlink(dest, path.join(base, "out"));
  await assert.rejects(copyVerifiedInputImage(path.join(root, "a.png"), [root], path.join(base, "out")), rejected("symlink in path"));
});

test("output ownership: reserved UUID path verified by signature and hash", async () => {
  const dir = await tmp();
  const r = await reserveOutput(dir, "png");
  await assert.rejects(verifyOwnedOutput(r), rejected("path component missing"));
  await fsp.writeFile(r.path, PNG);
  const v = await verifyOwnedOutput(r, sha256(PNG));
  assert.equal(v.type, "png");
  await assert.rejects(verifyOwnedOutput(r, sha256(JPEG)), rejected("output hash mismatch"));
  await assert.rejects(verifyOwnedOutput({ ...r, path: path.join(dir, "other.png") }), rejected("output name not owned"));
});

test("output ownership: symlink planted at reserved path is rejected", async () => {
  const dir = await tmp();
  const outside = await tmp();
  await fsp.writeFile(path.join(outside, "x.png"), PNG);
  const r = await reserveOutput(dir, "png");
  await fsp.symlink(path.join(outside, "x.png"), r.path);
  await assert.rejects(verifyOwnedOutput(r), rejected("symlink in path"));
});

test("output ownership: non-image content at reserved path is rejected", async () => {
  const dir = await tmp();
  const r = await reserveOutput(dir, "png");
  await fsp.writeFile(r.path, "fake success");
  await assert.rejects(verifyOwnedOutput(r), rejected("not a PNG or JPEG image"));
});
