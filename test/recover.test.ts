// NON-LIVE: read-only recovery against a fixture app-server; no Codex process is spawned.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recoverOwnedImage } from "../src/recover.js";
import { defaultReply, FakeAppServer } from "./fake-app-server.js";

const OWNED = "01a134d0-aebf-7840-8bc2-5d9f9d816c96";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function setup(): { home: string; out: string; saved: string } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cim-rec-")));
  const home = path.join(base, "codex-home");
  const dir = path.join(home, "generated_images", OWNED);
  mkdirSync(dir, { recursive: true });
  const saved = path.join(dir, "exec-1.png");
  writeFileSync(saved, PNG);
  return { home, out: path.join(base, "recovered-owned"), saved };
}

const FORBIDDEN = ["thread/start", "turn/start", "thread/resume", "thread/fork", "turn/steer", "model/list", "config/read", "account/read"];

test("recovery sends only initialize + thread/read and copies the native savedPath with verified hashes", async () => {
  const { home, out, saved } = setup();
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "thread/read") {
        const item = { type: "imageGeneration", id: "ig", status: "completed", revisedPrompt: null, result: PNG.toString("base64"), savedPath: saved };
        return { result: { thread: { id: OWNED, turns: [{ id: "t1", status: "failed", items: [{ type: "userMessage", id: "u" }, item] }] } } };
      }
      return defaultReply(msg);
    },
  });
  const ev = await recoverOwnedImage({ threadId: OWNED, createTransport: () => fake, codexHome: home, outputRoot: out, clientVersion: "0" });
  assert.deepEqual(fake.methods(), ["initialize", "initialized", "thread/read"]);
  for (const m of FORBIDDEN) assert.ok(!fake.methods().includes(m), m);
  assert.deepEqual(fake.received.find((m) => m.method === "thread/read")!.params, { threadId: OWNED, includeTurns: true });
  assert.equal(fake.killed, true);
  assert.equal(ev.recovered, true);
  assert.deepEqual(ev.thread_read, { ok: true, reason: null, image_items: 1, saved_paths: 1 });
  const f = ev.files[0]!;
  assert.equal(f.source, "native_saved_path");
  assert.equal(f.sha256, sha(PNG));
  assert.equal(f.signature, "png");
  assert.equal(f.copy_rehash_match, true);
  assert.equal(f.inline_result_match, true);
  assert.equal(f.mime_type, "image/png");
  assert.match(path.relative(out, f.path), /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(readFileSync(f.path), PNG);
  assert.deepEqual(readFileSync(saved), PNG, "source untouched");
  assert.ok(!JSON.stringify(ev).includes(PNG.toString("base64")));
});

test("thread/read unavailable: no savedPath is fabricated; file is labelled metadata_correlated", async () => {
  const { home, out } = setup();
  const fake = new FakeAppServer();
  const ev = await recoverOwnedImage({ threadId: OWNED, createTransport: () => fake, codexHome: home, outputRoot: out, clientVersion: "0" });
  assert.deepEqual(fake.methods(), ["initialize", "initialized", "thread/read"]);
  assert.equal(ev.thread_read.ok, false);
  assert.equal(ev.thread_read.reason, "thread/read failed: rpc method_not_found/unrecognized");
  assert.equal(ev.thread_read.saved_paths, 0);
  assert.equal(ev.files.length, 1);
  assert.equal(ev.files[0]!.source, "metadata_correlated");
  assert.equal(ev.files[0]!.inline_result_match, null);
  assert.match(ev.note, /not by a native savedPath event/);
});

test("thread/read for a different thread id or a savedPath outside Codex home is rejected", async () => {
  const { home, out } = setup();
  const other = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "thread/read") return { result: { thread: { id: "someone-else", turns: [] } } };
      return defaultReply(msg);
    },
  });
  const ev = await recoverOwnedImage({ threadId: OWNED, createTransport: () => other, codexHome: home, outputRoot: out, clientVersion: "0" });
  assert.equal(ev.thread_read.ok, false);
  assert.equal(ev.files[0]?.source, "metadata_correlated");

  const outside = path.join(path.dirname(home), "outside.png");
  writeFileSync(outside, PNG);
  const bad = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "thread/read") {
        return { result: { thread: { id: OWNED, turns: [{ items: [{ type: "imageGeneration", id: "i", status: "completed", result: "", savedPath: outside }] }] } } };
      }
      return defaultReply(msg);
    },
  });
  await assert.rejects(recoverOwnedImage({ threadId: OWNED, createTransport: () => bad, codexHome: home, outputRoot: out, clientVersion: "0" }));
  await assert.rejects(recoverOwnedImage({ threadId: "../x", createTransport: () => bad, codexHome: home, outputRoot: out, clientVersion: "0" }));
});
