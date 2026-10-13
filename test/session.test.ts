// NON-LIVE: every test drives a scripted fake app-server; no Codex process is spawned.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, DENIED_CODE } from "../src/codex-client.js";
import os from "node:os";
import { runDelegatedTurn, TaskError, threadPolicyMismatch, threadStartParams, turnStartParams, type RunOptions } from "../src/session.js";
import { MAX_MODEL_PAGES } from "../src/model-select.js";
import {
  agentMessage,
  completingScript,
  DEFAULT_MODEL,
  defaultReply,
  fakeModel,
  FakeAppServer,
  THREAD_ID,
  threadStartResult,
  TURN_ID,
  turnCompleted,
  type Script,
} from "./fake-app-server.js";

const CWD = "/work/project";

function opts(fake: FakeAppServer, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "say hi",
    cwd: CWD,
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

const lineOf = (fake: FakeAppServer, method: string): string => {
  const i = fake.received.findIndex((m) => m.method === method);
  assert.ok(i >= 0, method);
  return fake.lines[i]!;
};

const EXPECTED_THREAD_START =
  `{"cwd":"${CWD}","model":"${DEFAULT_MODEL}","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"}`;
const EXPECTED_SANDBOX_POLICY =
  `{"type":"workspaceWrite","writableRoots":["${CWD}"],"networkAccess":false,"excludeSlashTmp":true,"excludeTmpdirEnvVar":true}`;
const EXPECTED_TURN_START =
  `{"threadId":"${THREAD_ID}","input":[{"type":"text","text":"say hi","text_elements":[]}],"cwd":"${CWD}",` +
  `"approvalPolicy":"on-request","approvalsReviewer":"user","sandboxPolicy":${EXPECTED_SANDBOX_POLICY}}`;

test("happy path: new thread, workspace-write bounded to cwd, on-request/user approvals, no bypass", async () => {
  const fake = new FakeAppServer(completingScript([agentMessage("hello"), turnCompleted()]));
  const out = await runDelegatedTurn(opts(fake));
  assert.equal(out.text, "hello");
  assert.deepEqual(fake.methods(), ["initialize", "initialized", "model/list", "thread/start", "turn/start"]);
  const init = fake.received[0]!;
  assert.deepEqual((init.params as { capabilities: unknown }).capabilities, { experimentalApi: false, requestAttestation: false });
  // Stable client identity: name/ID unchanged, public title is the bridge, version passed through.
  assert.deepEqual((init.params as { clientInfo: unknown }).clientInfo, { name: "codex-image-mcp", title: "codex-claude-bridge", version: "test" });
  assert.deepEqual(fake.received.find((m) => m.method === "model/list")!.params, {});
  const ts = fake.received.find((m) => m.method === "thread/start")!.params!;
  for (const k of ["config", "modelProvider", "allowProviderModelFallback", "baseInstructions", "developerInstructions", "dynamicTools", "permissions", "runtimeWorkspaceRoots"]) {
    assert.ok(!(k in ts), k);
  }
  const sent = fake.lines.join("\n");
  for (const bad of ["never", "danger-full-access", "dangerFullAccess", "externalSandbox", "auto_review", "guardian_subagent", "granular", '"networkAccess":true', "thread/resume", "thread/fork", "bypass"]) {
    assert.ok(!sent.includes(bad), bad);
  }
  assert.equal(fake.killed, true, "process is always terminated after the job");
});

test("thread/start and turn/start params are byte-exact (explicit cwd, policy, reviewer, sandboxPolicy)", async () => {
  const fake = new FakeAppServer(completingScript([turnCompleted()]));
  await runDelegatedTurn(opts(fake));
  const ts = fake.received.find((m) => m.method === "thread/start")!;
  const tr = fake.received.find((m) => m.method === "turn/start")!;
  assert.equal(lineOf(fake, "thread/start"), `{"jsonrpc":"2.0","id":${ts.id},"method":"thread/start","params":${EXPECTED_THREAD_START}}`);
  assert.equal(lineOf(fake, "turn/start"), `{"jsonrpc":"2.0","id":${tr.id},"method":"turn/start","params":${EXPECTED_TURN_START}}`);
  // Builders used by scripts/diagnose.mjs serialize identically.
  assert.equal(JSON.stringify(threadStartParams(CWD, DEFAULT_MODEL)), EXPECTED_THREAD_START);
  assert.equal(JSON.stringify(turnStartParams(THREAD_ID, "say hi", CWD)), EXPECTED_TURN_START);
});

test("turn sandboxPolicy never broadens: only cwd writable, no network, /tmp and $TMPDIR excluded", () => {
  const p = turnStartParams(THREAD_ID, "x", CWD).sandboxPolicy as Record<string, unknown>;
  assert.deepEqual(p.writableRoots, [CWD]);
  assert.equal(p.networkAccess, false);
  assert.equal(p.excludeSlashTmp, true);
  assert.equal(p.excludeTmpdirEnvVar, true);
  assert.equal(p.type, "workspaceWrite");
});

test("policy builders reject an unvalidated cwd shape (relative, root, home, home ancestor, non-normalized)", () => {
  const home = os.homedir();
  for (const bad of ["relative", "/", home, home.split("/").slice(0, -1).join("/") || "/", "/work/../etc", "/work/project/", ""]) {
    assert.throws(() => threadStartParams(bad, DEFAULT_MODEL), bad);
    assert.throws(() => turnStartParams(THREAD_ID, "x", bad), bad);
  }
});

test("runDelegatedTurn refuses a bad cwd before spawning anything", async () => {
  let spawned = false;
  await assert.rejects(
    runDelegatedTurn({
      ...opts(new FakeAppServer()),
      cwd: "/",
      createTransport: () => {
        spawned = true;
        return new FakeAppServer();
      },
    }),
    (e: unknown) => {
      assert.ok(e instanceof TaskError && e.code === "POLICY_MISMATCH");
      assert.deepEqual(e.diagnostic, { phase: "spawn", policy_mismatch: "cwd" });
      return true;
    },
  );
  assert.equal(spawned, false);
});

// Effective ThreadStartResponse policy checks: [label, overrides, sandbox overrides, expected mismatch].
const MISMATCHES: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
  ["approvalPolicy never", { approvalPolicy: "never" }, {}, "approval_policy"],
  ["approvalPolicy untrusted", { approvalPolicy: "untrusted" }, {}, "approval_policy"],
  ["approvalPolicy granular", { approvalPolicy: { granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } } }, {}, "approval_policy"],
  ["approvalPolicy missing", { approvalPolicy: undefined }, {}, "approval_policy"],
  ["reviewer auto_review", { approvalsReviewer: "auto_review" }, {}, "approvals_reviewer"],
  ["reviewer guardian_subagent", { approvalsReviewer: "guardian_subagent" }, {}, "approvals_reviewer"],
  ["sandbox dangerFullAccess", { sandbox: { type: "dangerFullAccess" } }, {}, "sandbox_type"],
  ["sandbox externalSandbox", { sandbox: { type: "externalSandbox", networkAccess: "enabled" } }, {}, "sandbox_type"],
  ["sandbox readOnly", { sandbox: { type: "readOnly", networkAccess: false } }, {}, "sandbox_type"],
  ["sandbox missing", { sandbox: undefined }, {}, "invalid_shape"],
  ["network enabled", {}, { networkAccess: true }, "network_access"],
  ["network non-boolean", {}, { networkAccess: "enabled" }, "network_access"],
  ["ambient root /", {}, { writableRoots: ["/"] }, "writable_roots"],
  ["ambient extra root", {}, { writableRoots: [CWD, "/Users/someone/SECRET_ROOT"] }, "writable_roots"],
  ["ambient /tmp root", {}, { writableRoots: ["/tmp"] }, "writable_roots"],
  ["ambient parent root", {}, { writableRoots: ["/work"] }, "writable_roots"],
  ["duplicate cwd root", {}, { writableRoots: [CWD, CWD] }, "writable_roots"],
  ["writableRoots not an array", {}, { writableRoots: CWD }, "invalid_shape"],
  ["tmp flag non-boolean", {}, { excludeSlashTmp: "yes" }, "invalid_shape"],
  ["response cwd differs", { cwd: "/work/other" }, {}, "cwd"],
  ["response cwd missing", { cwd: undefined }, {}, "cwd"],
];

for (const [label, overrides, sandbox, reason] of MISMATCHES) {
  test(`effective thread policy mismatch (${label}) fails POLICY_MISMATCH before any turn`, async () => {
    const fake = new FakeAppServer({
      onRequest(msg) {
        if (msg.method === "thread/start") return { result: threadStartResult(msg.params?.cwd, overrides, sandbox) };
        return defaultReply(msg);
      },
    });
    await assert.rejects(runDelegatedTurn(opts(fake)), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.code, "POLICY_MISMATCH");
      assert.deepEqual(e.diagnostic, { phase: "thread_start", policy_mismatch: reason });
      assert.ok(!JSON.stringify(e).includes("SECRET_ROOT"));
      return true;
    });
    assert.deepEqual(fake.methods(), ["initialize", "initialized", "model/list", "thread/start"], "no turn, no retry, no second thread");
    assert.equal(fake.killed, true);
  });
}

test("thread.cwd differing from the requested cwd is a mismatch", () => {
  const r = threadStartResult(CWD);
  (r.thread as Record<string, unknown>).cwd = "/work/other";
  assert.equal(threadPolicyMismatch(r, CWD), "cwd");
});

for (const [label, sandbox] of [
  ["implicit cwd root, default tmp flags", {}],
  ["explicit [cwd] root", { writableRoots: [CWD] }],
  ["tmp flags already excluded", { excludeSlashTmp: true, excludeTmpdirEnvVar: true }],
  ["schema-defaulted fields absent", { writableRoots: undefined, networkAccess: undefined, excludeSlashTmp: undefined, excludeTmpdirEnvVar: undefined }],
] as const) {
  test(`accepted effective thread policy: ${label}; the turn still sends the explicit bounded policy`, async () => {
    const fake = new FakeAppServer({
      onRequest(msg, ctx) {
        if (msg.method === "thread/start") return { result: threadStartResult(msg.params?.cwd, {}, sandbox) };
        return completingScript([turnCompleted()]).onRequest!(msg, ctx);
      },
    });
    await runDelegatedTurn(opts(fake));
    assert.equal(JSON.stringify(fake.received.find((m) => m.method === "turn/start")!.params), EXPECTED_TURN_START);
  });
}

test("normal in-cwd writes (fileChange + commandExecution items, no approval request) succeed", async () => {
  const item = (i: object) => ({ method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: i } });
  const fake = new FakeAppServer(
    completingScript([
      item({ type: "fileChange", id: "fc1", status: "completed", changes: [{ path: `${CWD}/new.txt`, kind: { type: "add" }, diff: "+hi" }] }),
      item({ type: "fileChange", id: "fc2", status: "completed", changes: [{ path: `${CWD}/new.txt`, kind: { type: "update", move_path: null }, diff: "-hi\n+bye" }] }),
      item({ type: "commandExecution", id: "ce1", status: "completed", command: "ls", commandActions: [], cwd: CWD, exitCode: 0 }),
      agentMessage("DONE"),
      turnCompleted(),
    ]),
  );
  const out = await runDelegatedTurn(opts(fake));
  assert.equal(out.text, "DONE");
  assert.ok(!fake.lines.some((l) => l.includes(String(DENIED_CODE))), "nothing was denied");
  assert.ok(!fake.methods().includes("turn/interrupt"));
});

test("elevated approval (outside-root file change) is denied without a fabricated decision and fails the job", async () => {
  const fake = new FakeAppServer(
    completingScript([
      { id: "elev", method: "item/fileChange/requestApproval", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "fc", grantRoot: "/" } },
      turnCompleted(),
    ]),
  );
  await rejectsWith(runDelegatedTurn(opts(fake)), "APPROVAL_REQUIRED", "file_change");
  const denial = fake.received.find((m) => m.id === "elev")!;
  assert.equal((denial.error as { code: number }).code, DENIED_CODE);
  assert.equal(denial.result, undefined);
  assert.ok(!fake.lines.some((l) => /"decision"|accept/i.test(l)), "never approves");
});

test("cancel while thread/start is pending: CANCELLED, no turn/start, process killed", async () => {
  const ac = new AbortController();
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "thread/start") {
        setTimeout(() => ac.abort("CANCELLED"), 5);
        return undefined;
      }
      return defaultReply(msg);
    },
  });
  await rejectsWith(runDelegatedTurn(opts(fake, { signal: ac.signal })), "CANCELLED");
  assert.ok(!fake.methods().includes("turn/start"));
  assert.equal(fake.killed, true);
});

test("cancel during a running workspace-write turn interrupts exactly that turn once", async () => {
  const ac = new AbortController();
  const fake = new FakeAppServer({
    onRequest(msg) {
      if (msg.method === "turn/start") setTimeout(() => ac.abort("CANCELLED"), 5);
      return defaultReply(msg);
    },
  });
  await rejectsWith(runDelegatedTurn(opts(fake, { signal: ac.signal })), "CANCELLED");
  const interrupts = fake.received.filter((m) => m.method === "turn/interrupt");
  assert.deepEqual(interrupts.map((m) => m.params), [{ threadId: THREAD_ID, turnId: TURN_ID }]);
  assert.equal(fake.methods().filter((m) => m === "turn/start").length, 1);
  assert.equal(fake.killed, true);
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

for (const [method, phase] of [
  ["initialize", "initialize"],
  ["model/list", "model_select"],
  ["thread/start", "thread_start"],
  ["turn/start", "turn_start"],
] as const) {
  test(`withheld ${method} response: RPC deadline yields TIMEOUT in phase ${phase}, no retry, transport terminated`, async () => {
    const fake = new FakeAppServer({ onRequest: (msg) => (msg.method === method ? undefined : defaultReply(msg)) });
    await assert.rejects(runDelegatedTurn(opts(fake, { rpcTimeoutMs: 20, timeoutMs: 5_000 })), (e: unknown) => {
      assert.ok(e instanceof TaskError);
      assert.equal(e.code, "TIMEOUT");
      assert.deepEqual(e.diagnostic, { phase });
      return true;
    });
    assert.equal(fake.methods().filter((m) => m === method).length, 1, "never retried");
    assert.ok(!fake.methods().includes("turn/interrupt"));
    assert.equal(fake.killed, true);
  });
}

test("approval request during a withheld RPC keeps APPROVAL_REQUIRED as root cause", async () => {
  const fake = new FakeAppServer({
    onRequest(msg, ctx) {
      if (msg.method === "thread/start") {
        setTimeout(() => ctx.send({ id: 7, method: "item/commandExecution/requestApproval", params: {} }), 1);
        return undefined;
      }
      return defaultReply(msg);
    },
  });
  await rejectsWith(runDelegatedTurn(opts(fake, { rpcTimeoutMs: 50 })), "APPROVAL_REQUIRED", "command_execution");
  assert.equal(fake.killed, true);
});

test("job signal aborted with reason TIMEOUT maps to TIMEOUT, other reasons to CANCELLED", async () => {
  for (const [reason, code] of [["TIMEOUT", "TIMEOUT"], ["CANCELLED", "CANCELLED"]] as const) {
    const fake = new FakeAppServer();
    const ac = new AbortController();
    const p = runDelegatedTurn(opts(fake, { signal: ac.signal }));
    setTimeout(() => ac.abort(reason), 10);
    await rejectsWith(p, code);
    assert.equal(fake.killed, true);
  }
});
