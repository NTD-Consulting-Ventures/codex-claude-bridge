# Workspace-write verification

Sanitized record of the live checks for the workspace-write policy. The machine-readable
version is [`workspace-write-verification.json`](workspace-write-verification.json). The
parent controlled every run and read the file bytes back itself. Raw
evidence (stream-json, stderr, prompts) stays in the git-ignored `.harness-evidence/` and
`.smoke/` folders. It is referenced here but not copied in: no session ids, raw prompts or
results, account, config or credential data.

Commit: this file does not record the commit. The final candidate commit and tree are
supplied in the Kanban handoff.

Earlier receipts ([`runtime-verification.md`](runtime-verification.md),
[`repair-verification.md`](repair-verification.md)) describe the earlier read-only policy
and are left as they were.

## Environment

- codex-cli **0.156.0** (official, logged in normally).
- App-server schema regenerated without the experimental API:
  `codex app-server generate-json-schema --out .harness-evidence/schema`.

  | schema file | sha256 |
  |---|---|
  | `ThreadStartParams.json` | `e9c6d3cc18d049bfbc0249add3808fb8e5a27e1a0b5a423767aafbc3859a9428` |
  | `ThreadStartResponse.json` | `daaeb4c716e78d93e53c646224e4bfe11ca13bd6aa23ae6ee60103a12da30745` |
  | `TurnStartParams.json` | `2dfcf68705896fadc344ccfeb2e9fe5a6bcbbb8b9a90cf449ce232b636daf05a` |

- Claude Code **2.1.293**; `--model opus` resolved to `claude-opus-5-5` in every run.

## Policy under test

- `thread/start`: `cwd`, `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`,
  `sandbox: "workspace-write"`, and the single `isDefault` model from that process's
  `model/list`. Every job uses a new app-server process and a new thread.
- `turn/start`: explicit `sandboxPolicy`
  `{type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true}`.
- Before `turn/start`, the effective thread policy must report `cwd`, `on-request`,
  reviewer `user`, `workspaceWrite`, network not enabled, and `writableRoots` empty or
  exactly `[cwd]`. Anything else is `POLICY_MISMATCH` and no turn is started.
- Approvals are not bridged. Every server request is denied and fails the job
  (`APPROVAL_REQUIRED` / `UNSUPPORTED_SERVER_REQUEST`).
- Trusted-local: plugins, hooks and MCP servers from the user's Codex config remain
  active and are not contained by the sandbox. `cwd` is validated only at start (TOCTOU).

## Live policy diagnostic (thread/start only, no turn)

Evidence: `.harness-evidence/policy-diagnostic.json` (`node scripts/diagnose.mjs`).

| field | thread-level value |
|---|---|
| cwd matches | true |
| approval policy / reviewer | `on-request` / `user` |
| sandbox type | `workspaceWrite` |
| networkAccess | false |
| writableRoots | `[]` (0 entries) |
| excludeSlashTmp / excludeTmpdirEnvVar | false / false |
| policy_mismatch | none |

This is the thread default **before** the explicit turn override. An empty `writableRoots`
means `cwd` is the implicit root, which is accepted. `thread/start` cannot set the temp
exclusions, so the thread-level check allows them to be false. The turn's explicit
`sandboxPolicy` sets both to `true`. The diagnostic shows only the thread level; the
turn-level effect of the temp exclusions was not probed separately.

## Fixture checks (final, parent run)

| command | outcome | log |
|---|---|---|
| `npm test` | 177/177 pass, 0 fail | `.harness-evidence/tests-final.log` |
| `npm run lint` | exit 0 | `.harness-evidence/lint-final.log` |
| `npm run typecheck` | exit 0 | `.harness-evidence/typecheck-final.log` |
| `npm run build` | exit 0 | `.harness-evidence/build-final.log` |
| `git diff --check` | exit 0 | — |

The 177 tests include the `cwd` shape fixture. Fixtures never spawn Codex or `claude`.

## Harness commands

Every phase ran `claude -p "<prompt file>"` (Claude Code 2.1.293). These flags were the
same in all phases:

```
--model opus --no-session-persistence --strict-mcp-config --setting-sources ''
--permission-mode dontAsk --permission-prompts none --disable-slash-commands
--output-format stream-json --verbose --max-turns 60
```

Phase-specific flags:

- Implementation phases (`implement`, `finish`): `--safe-mode --restricted
  --tools Read,Write,Edit,Glob,Grep --allowedTools Read,Write,Edit,Glob,Grep`. No shell.
- MCP-only phases (`smoke-*`): `--tools ''` (no built-in tools, so no direct file
  access), `--mcp-config .harness-evidence/smoke-mcp.json`, and
  `--allowedTools mcp__<server>__codex_task_start,mcp__<server>__codex_task_status,mcp__<server>__codex_status`.

No phase used a fallback model or path, and none was retried automatically.

## Implementation runs

| phase | wall limit | outcome |
|---|---|---|
| `implement` | 570 s configured | **Interrupted at 420 s, no result** (no turn count, duration or denial count reported). Its edits were kept. |
| `finish` | 360 s | `success`, exit 0, 199.773 s wall (reported 198.945 s), 60 turns, 0 permission denials |

## Live runs through Claude Code (MCP tools only)

Task `cwd` = `.smoke/workspace-write/workspace` (passed as the canonical absolute path).

| phase | server name | result |
|---|---|---|
| `smoke-create` | `workspace` | **Setup failure, not a test of the server.** `workspace` is a reserved name. The session started with zero tools and zero MCP servers, so no task was started (1 turn, exit 0, 6.335 s). |
| `smoke-create2` | `writecheck` | 4 tools connected; exactly 1 `codex_task_start`; job `succeeded`; result `success`, 9 turns, 0 permission denials, exit 0, 21.856 s |
| `smoke-modify` | `writecheck` | 4 tools connected; exactly 1 `codex_task_start` (new thread/process); job `succeeded`; result `success`, 10 turns, 0 permission denials, exit 0, 24.514 s |

`smoke-create2` was a separate run that the parent started after correcting the server
name. It was not an automatic retry. No approval was requested or granted in either
successful run. Summaries: `.harness-evidence/smoke-*-summary.json`.

## Read-back (independent, by the parent)

Evidence: `.smoke/workspace-write/readback.json`. File:
`.smoke/workspace-write/workspace/receipt.txt`.

| snapshot | exact UTF-8 bytes | size | sha256 |
|---|---|---|---|
| after create (`receipt-initial.txt`) | `workspace-write initial receipt\n` | 32 | `bb4d6e872f9dfa75bf2673bf7c95c94146ff1926882757a40ed90a4d8089e911` |
| after modify (`receipt-final.txt`) | `workspace-write final receipt\n` | 30 | `8d989a0aa466a6f64d161f2934d98ec6d462b7decf4afe3d39f613ac72862995` |

Diff (`.smoke/workspace-write/receipt.diff`):

```diff
--- receipt-initial.txt
+++ receipt-final.txt
@@ -1 +1 @@
-workspace-write initial receipt
+workspace-write final receipt
```

Outside sentinel `.smoke/workspace-write/outside-sentinel.txt` (next to, not inside, the
workspace): sha256 `d8513fc069df2d05af11a33732a1f5dd349645fd0af3e0a765e81e062625aabc` before
and after, so it is unchanged.

## Not verified

- `node scripts/smoke.mjs write` (MCP SDK client; now checks exact bytes) was **not** run.
  The Claude runs above are the live evidence, and the SDK smoke does not replace them.
- A live outside-`cwd` write or network attempt ending in `APPROVAL_REQUIRED`, and a live
  `POLICY_MISMATCH`. These are covered by fixtures only.
- A live check that the temp exclusions take effect at turn level (see the diagnostic above).
- Claude Desktop Local discovery.
- Image generation under the workspace-write policy.
