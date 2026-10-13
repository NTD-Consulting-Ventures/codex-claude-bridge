// NON-LIVE: pure classification/redaction of fixture strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTurnMessage, httpStatusFromMessage, MAX_REDACTED_CHARS, redactMessage } from "../src/turn-error.js";

test("turn messages map to fixed classes; first match wins", () => {
  const cases: [unknown, string][] = [
    ["after_agent hook 'h' failed and aborted turn completion: boom", "hook_aborted"],
    ["upstream rejected request: missing x-oai-attestation", "attestation"],
    ["401 Unauthorized", "auth"],
    ["Unsupported parameter: 'reasoning.summary'", "unsupported_parameter"],
    ["Model provider `foo` not found", "provider"],
    ["The model `gpt-x` does not exist or you do not have access to it.", "model"],
    ["stream disconnected before completion: error sending request", "network"],
    ["unexpected status 503 Service Unavailable", "server_error"],
    ["something else entirely", "unrecognized"],
    ["", "absent"],
    [undefined, "absent"],
    [42, "absent"],
  ];
  for (const [msg, cls] of cases) assert.equal(classifyTurnMessage(msg), cls, String(msg));
  assert.equal(classifyTurnMessage("x".repeat(5000) + " network"), "unrecognized", "scan is bounded");
});

test("http status is taken from the message only when named and in the fixed set", () => {
  assert.equal(httpStatusFromMessage("unexpected status 404 Not Found"), 404);
  assert.equal(httpStatusFromMessage("HTTP 502"), 502);
  assert.equal(httpStatusFromMessage("status code: 429"), 429);
  assert.equal(httpStatusFromMessage("status 599"), null);
  assert.equal(httpStatusFromMessage("took 500 ms"), null);
  assert.equal(httpStatusFromMessage(null), null);
});

test("redaction removes credentials, identity, urls, paths and ids and bounds length", () => {
  const raw =
    "Bearer abc.def token=tok123 api_key: k1 sk-proj-AbCdEf123456 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig " +
    "user someone@example.org at https://api.example.com/v1/x?key=SECRETQ in /Users/niki/.codex/config.toml " +
    "~/x/y C:\\Users\\n acct 123e4567-e89b-12d3-a456-426614174000 opaque " + "Z".repeat(40) + " and/or ok\u0007";
  const r = redactMessage(raw)!;
  for (const leak of ["abc.def", "tok123", "k1 ", "sk-proj", "eyJ", "someone@", "example.org", "example.com", "SECRETQ", "/Users", ".codex", "~/x", "C:\\", "123e4567", "ZZZZ", "\u0007"]) {
    assert.ok(!r.includes(leak), `${leak} in ${r}`);
  }
  assert.match(r, /and\/or ok$/);
  assert.ok(redactMessage("a ".repeat(2000))!.length <= MAX_REDACTED_CHARS + 1);
  assert.equal(redactMessage(undefined), null);
});
