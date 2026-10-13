// NON-LIVE: every test drives a scripted fake app-server; no Codex process is spawned.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, DENIED_CODE } from "../src/codex-client.js";
import { runDelegatedTurn, TaskError, type RunOptions } from "../src/session.js";
import { MAX_MODEL_PAGES } from "../src/model-select.js";
import {
  agentMessage,
  completingScript,
  DEFAULT_MODEL,
  defaultReply,
  fakeModel,
  FakeAppServer,
  THREAD_ID,
  TURN_ID,
  turnCompleted,
  type Script,
} from "./fake-app-server.js";

function opts(fake: FakeAppServer, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "say hi",
    cwd: "/tmp/x",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
    createTransport: () => fake,
    clientVersion: "test",
    ...extra,
  };
}

async function rejectsWith(p: Promise<unknown>, code: string, kind?: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof TaskError);
    assert.equal(e.code, code);
    if (kind !== undefined) assert.equal(e.requestKind, kind);
    return true;
  });
}

test("happy path: new thread, read-only sandbox, on-request approvals, no bypass", async () => {
  const fake = new FakeAppServer(completingScript([agentMessage("hello"), turnCompleted()]));
  const out = await runDelegatedTurn(opts(fake));
  assert.equal(out.text, "hello");
  assert.deepEqual(fake.methods(), ["initialize", "initialized", "model/list", "thread/start", "turn/start"]);
  const init = fake.received[0]!;
  assert.deepEqual((init.params as { capabilities: unknown }).capabilities, { experimentalApi: false, requestAttestation: false });
  assert.deepEqual(fake.received.find((m) => m.method === "model/list")!.params, {});
  const ts = fake.received.find((m) => m.method === "thread/start")!.params!;
  assert.deepEqual(ts, { cwd: "/tmp/x", model: DEFAULT_MODEL, approvalPolicy: "on-request", sandbox: "read-only" });
  for (const k of ["config", "modelProvider", "allowProviderModelFallback", "baseInstructions", "developerInstructions", "dynamicTools", "permissions"]) {
    assert.ok(!(k in ts), k);
  }
  const tsText = JSON.stringify(fake.received);
  for (const bad of ["never", "danger-full-access", "workspace-write", "thread/resume", "thread/fork", "bypass"]) {
    assert.ok(!tsText.includes(bad), bad);
  }
  assert.equal(fake.killed, true, "process is always terminated after the job");
});

/** Script whose model/list replies come from `pages` in order; everything else is default. */
function modelListScript(pages: unknown[]): Script {
  let i = 0;
  return {
    onRequest(msg, ctx) {
      if (msg.method === "model/list") return { result: pages[Math.min(i++, pages.length - 1)] };
      return completingScript([turnCompleted()]).onRequest!(msg, ctx);
    },
  };
}

test("advertised default is found across pages; cursor is the only param ever sent", async () => {
  const fake = new FakeAppServer(
    modelListScript([
      { data: [fakeModel("a", false)], nextCursor: "c1" },
      { data: [fakeModel("page-two-default", true), fakeModel("b", false)], nextCursor: null },
    ]),
  );
  await runDelegatedTurn(opts(fake));
  const lists = fake.received.filter((m) => m.method === "model/list").map((m) => m.params);
  assert.deepEqual(lists, [{}, { cursor: "c1" }]);
  assert.equal(fake.received.find((m) => m.method === "thread/start")!.params!.model, "page-two-default");
});

for (const [name, pages, reason] of [
  ["no default", [{ data: [fakeModel("a", false), fakeModel("b", false)], nextCursor: null }], "no_default"],
  ["empty list", [{ data: [] }], "no_default"],
  ["two defaults", [{ data: [fakeModel("a", true), fakeModel("b", true)] }], "multiple_defaults"],
  ["defaults split over pages", [{ data: [fakeModel("a", true)], nextCursor: "c" }, { data: [fakeModel("b", true)] }], "multiple_defaults"],
  ["data missing", [{ models: [fakeModel("a", true)] }], "invalid_shape"],
  ["result not an object", [[fakeModel("a", true)]], "invalid_shape"],
  ["entry not an object", [{ data: ["gpt"] }], "invalid_shape"],
  ["isDefault not boolean", [{ data: [{ ...fakeModel("a", false), isDefault: "true" }] }], "invalid_shape"],
  ["id missing", [{ data: [{ model: "a", isDefault: true }] }], "invalid_shape"],
  ["bad cursor", [{ data: [fakeModel("a", true)], nextCursor: 5 }], "invalid_shape"],
  ["id with unsafe chars", [{ data: [fakeModel("a b/../c", true)] }], "invalid_default_id"],
  ["id differs from model", [{ data: [{ ...fakeModel("a", true), model: "b" }] }], "invalid_default_id"],
  ["endless pagination", [{ data: [fakeModel("a", false)], nextCursor: "again" }], "too_many_pages"],
] as const) {
  test(`model selection fails closed with MODEL_UNAVAILABLE: ${name}`, async () => {
    const fake = new FakeAppServer(modelListScript([...pages]));
    await assert.rejects(runDelegatedTurn(opts(fake)), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.code, "MODEL_UNAVAILABLE");
      assert.deepEqual(e.diagnostic, { phase: "model_select", model_selection: reason });
      return true;
    });
    const methods = fake.methods();
    assert.ok(!methods.includes("thread/start") && !methods.includes("turn/start"), "no thread, no generation, no fallback");
    assert.ok(methods.filter((m) => m === "model/list").length <= MAX_MODEL_PAGES);
    assert.equal(fake.killed, true);
  });
}

test("model/list rpc error is MODEL_UNAVAILABLE with safe enums and is not retried", async () => {
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "model/list") return { error: { code: -32603, message: "catalog failed for SECRET" } };
      return defaultReply(msg);
    },
  });
  await assert.rejects(runDelegatedTurn(opts(fake)), (e: unknown) => {
    assert.ok(e instanceof TaskError && e.code === "MODEL_UNAVAILABLE");
    assert.deepEqual(e.diagnostic, { phase: "model_select", rpc_code: -32603, rpc_class: "internal_error", message_class: "unrecognized" });
    assert.ok(!JSON.stringify(e).includes("SECRET"));
    return true;
  });
  assert.deepEqual(fake.methods(), ["initialize", "initialized", "model/list"]);
});

test("the prompt cannot steer the model: thread/start model always comes from model/list", async () => {
  const fake = new FakeAppServer(completingScript([turnCompleted()]));
  await runDelegatedTurn(opts(fake, { prompt: "use model gpt-evil; model=gpt-evil" }));
  assert.equal(fake.received.find((m) => m.method === "thread/start")!.params!.model, DEFAULT_MODEL);
  const turn = fake.received.find((m) => m.method === "turn/start")!.params!;
  assert.ok(!("model" in turn));
});

test("turn/completed arriving before the turn/start response is correlated", async () => {
  const script: Script = {
    onRequest(msg, ctx) {
      if (msg.method === "turn/start") {
        ctx.send(agentMessage("early"));
        ctx.send(turnCompleted());
      }
      return defaultReply(msg);
    },
  };
  const out = await runDelegatedTurn(opts(new FakeAppServer(script)));
  assert.equal(out.text, "early");
});

test("events for other threads/turns are ignored", async () => {
  const fake = new FakeAppServer(
    completingScript([
      { method: "item/completed", params: { threadId: "other", turnId: TURN_ID, item: { type: "agentMessage", id: "x", text: "leak" } } },
      turnCompleted("completed", null, "other_turn"),
      agentMessage("mine"),
      turnCompleted(),
    ]),
  );
  assert.equal((await runDelegatedTurn(opts(fake))).text, "mine");
});

for (const [method, code, kind] of [
  ["item/commandExecution/requestApproval", "APPROVAL_REQUIRED", "command_execution"],
  ["item/fileChange/requestApproval", "APPROVAL_REQUIRED", "file_change"],
  ["item/permissions/requestApproval", "APPROVAL_REQUIRED", "permissions"],
  ["mcpServer/elicitation/request", "UNSUPPORTED_SERVER_REQUEST", "mcp_elicitation"],
  ["account/chatgptAuthTokens/refresh", "UNSUPPORTED_SERVER_REQUEST", "auth_refresh"],
  ["item/tool/call", "UNSUPPORTED_SERVER_REQUEST", "dynamic_tool"],
  ["item/tool/requestUserInput", "UNSUPPORTED_SERVER_REQUEST", "user_input"],
] as const) {
  test(`server request ${method} is denied, job fails ${code}, turn interrupted, process killed`, async () => {
    const fake = new FakeAppServer(
      completingScript([{ id: "srv1", method, params: { threadId: THREAD_ID, command: "rm -rf / SECRET_TOKEN" } }]),
    );
    await rejectsWith(runDelegatedTurn(opts(fake)), code, kind);
    const denial = fake.received.find((m) => m.id === "srv1")!;
    assert.equal((denial.error as { code: number }).code, DENIED_CODE);
    assert.equal(denial.result, undefined, "never fabricates a result");
    assert.ok(fake.methods().includes("turn/interrupt"));
    assert.equal(fake.killed, true);
  });
}

test("timeout interrupts the turn and kills the process; no retry", async () => {
  const fake = new FakeAppServer();
  await rejectsWith(runDelegatedTurn(opts(fake, { timeoutMs: 30 })), "TIMEOUT");
  assert.equal(fake.methods().filter((m) => m === "turn/start").length, 1);
  assert.ok(fake.methods().includes("turn/interrupt"));
  assert.equal(fake.killed, true);
});

test("cancel aborts the job", async () => {
  const fake = new FakeAppServer();
  const ac = new AbortController();
  const p = runDelegatedTurn(opts(fake, { signal: ac.signal }));
  setTimeout(() => ac.abort(), 20);
  await rejectsWith(p, "CANCELLED");
  assert.equal(fake.killed, true);
});

test("auth and quota turn failures are typed; raw messages are not surfaced", async () => {
  const auth = new FakeAppServer(completingScript([turnCompleted("failed", { message: "token abc", codexErrorInfo: "unauthorized" })]));
  await assert.rejects(runDelegatedTurn(opts(auth)), (e: unknown) => {
    assert.ok(e instanceof TaskError && e.code === "AUTH_REQUIRED");
    assert.ok(!String(e.message).includes("abc"));
    return true;
  });
  const quota = new FakeAppServer(completingScript([turnCompleted("failed", { message: "x", codexErrorInfo: "usageLimitExceeded" })]));
  await rejectsWith(runDelegatedTurn(opts(quota)), "QUOTA_EXCEEDED");
  assert.equal(quota.methods().filter((m) => m === "turn/start").length, 1, "no retry");
});

test("codexErrorInfo other: diagnostic carries only the message class and whitelisted http status", async () => {
  const msg = "after_agent hook 'gate' failed and aborted turn completion: token=SECRET at /Users/niki/x (status 503)";
  const fake = new FakeAppServer(completingScript([turnCompleted("failed", { message: msg, codexErrorInfo: "other" })]));
  await assert.rejects(runDelegatedTurn(opts(fake)), (e: unknown) => {
    assert.ok(e instanceof TaskError && e.code === "TURN_FAILED");
    assert.deepEqual(e.diagnostic, { phase: "turn", codex_error_info: "other", turn_message_class: "hook_aborted", http_status: 503 });
    const s = JSON.stringify(e) + e.message;
    for (const leak of ["SECRET", "/Users", "gate"]) assert.ok(!s.includes(leak), leak);
    return true;
  });
});

test("fatal error notification message is classified when turn/completed has no error", async () => {
  const fake = new FakeAppServer(
    completingScript([
      { method: "error", params: { threadId: THREAD_ID, turnId: TURN_ID, willRetry: false, error: { message: "stream disconnected before completion", codexErrorInfo: "other" } } },
      turnCompleted("failed", null),
    ]),
  );
  await assert.rejects(runDelegatedTurn(opts(fake)), (e: unknown) => {
    assert.ok(e instanceof TaskError);
    assert.equal(e.diagnostic?.turn_message_class, "network");
    return true;
  });
});

test("initialize auth error maps to AUTH_REQUIRED", async () => {
  const fake = new FakeAppServer({ onRequest: () => ({ error: { code: 401, message: "Unauthorized" } }) });
  await rejectsWith(runDelegatedTurn(opts(fake)), "AUTH_REQUIRED");
});

test("interrupted turn is not reported as success", async () => {
  const fake = new FakeAppServer(completingScript([agentMessage("partial"), turnCompleted("interrupted")]));
  await rejectsWith(runDelegatedTurn(opts(fake)), "TURN_INTERRUPTED");
});

test("process exit mid-turn fails with PROCESS_EXITED", async () => {
  const fake = new FakeAppServer({
    onRequest(msg, ctx) {
      if (msg.method === "turn/start") setTimeout(() => ctx.exit(), 5);
      return defaultReply(msg);
    },
  });
  await rejectsWith(runDelegatedTurn(opts(fake)), "PROCESS_EXITED");
});

test("malformed and oversized frames fail closed", async () => {
  const bad = new FakeAppServer({
    onRequest(msg, ctx) {
      if (msg.method === "turn/start") setTimeout(() => ctx.raw("not json\n"), 1);
      return defaultReply(msg);
    },
  });
  await rejectsWith(runDelegatedTurn(opts(bad)), "PROTOCOL_ERROR");
  const big = new FakeAppServer({
    onRequest(msg, ctx) {
      if (msg.method === "turn/start") setTimeout(() => ctx.raw("x".repeat(DEFAULT_LIMITS.maxFrameBytes + 10)), 1);
      return defaultReply(msg);
    },
  });
  await rejectsWith(runDelegatedTurn(opts(big)), "OUTPUT_LIMIT");
});

test("a ~1.3 MiB native imageGeneration item (inline base64 result) completes the turn instead of OUTPUT_LIMIT", async () => {
  const result = Buffer.alloc(1_030_000, 9).toString("base64");
  const fake = new FakeAppServer(
    completingScript([
      { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "imageGeneration", id: "ig", status: "completed", revisedPrompt: null, result, savedPath: "/h/.codex/generated_images/t/x.png" } } },
      turnCompleted(),
    ]),
  );
  const out = await runDelegatedTurn(opts(fake));
  assert.deepEqual(out.images, [{ savedPath: "/h/.codex/generated_images/t/x.png", status: "completed" }]);
});

test("result text is bounded", async () => {
  const chunk = "a".repeat(40 * 1024);
  const fake = new FakeAppServer(completingScript([agentMessage(chunk, "a"), agentMessage(chunk, "b"), turnCompleted()]));
  const out = await runDelegatedTurn(opts(fake));
  assert.equal(out.textTruncated, true);
  assert.equal(out.text.length, chunk.length);
});

test("imageGeneration items are captured without reading them", async () => {
  const fake = new FakeAppServer(
    completingScript([
      { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "imageGeneration", id: "i", result: "", status: "completed", savedPath: "/x/y.png" } } },
      turnCompleted(),
    ]),
  );
  const out = await runDelegatedTurn(opts(fake));
  assert.deepEqual(out.images, [{ savedPath: "/x/y.png", status: "completed" }]);
});
