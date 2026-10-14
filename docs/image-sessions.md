# Image sessions (follow-up edits)

`codex_image_generate` can run a follow-up such as "make the sky darker" as a new turn
on the same native Codex thread as an earlier image, so that Codex has that image in
its thread context. Continuity is opt-in for every call: it happens only when you pass
back a `session_handle` this server returned.

Status: covered by fixture tests only (scripted app-server peers and injected
capability results over the real MCP SDK protocol). They prove the protocol sequence
and that the edit turn runs on the thread whose fixture history holds the first image
and prompt. Whether a live model actually edits that image has **not** been verified
for this release.

## Usage

1. Call `codex_image_generate` with `{prompt, cwd}`. The start response and the
   succeeded result include `session_handle` (an opaque `cis_…` value) and `session`
   metadata.
2. To refine that image, call again with the same `cwd`, the same `session_handle`, and
   only the requested change as `prompt`.
3. For an unrelated image, leave out `session_handle`. To discard a session explicitly,
   pass `fresh_session: true` (with or without the old handle). The old handle is then
   revoked and a new thread and handle are created. A handle this process never issued
   (for example after a restart) is rejected with `SESSION_UNKNOWN` even together with
   `fresh_session: true`; to recover, omit `session_handle`.

Reuse a handle only for edits of the image it belongs to. The server does not guess:
MCP over stdio cannot tell which Claude conversation a call came from, so a call
without a handle always starts a new thread.

## What the server does

- **First image.** A new native thread is created with `thread/start`, using the same
  launch policy as every other job (`workspace-write` limited to `cwd`, no network,
  `on-request` approvals reviewed by the user). The single-image guidance is sent as the
  thread's native `developerInstructions`, so your prompt reaches Codex unchanged. The
  thread gets a fixed name through `thread/name/set` (params `threadId`, `name`) when
  the discovered schema lists that method.
- **Follow-up.** A new app-server process runs `thread/resume` on the native thread id
  that this server recorded after its own `thread/start`. The resume uses the same
  explicit cwd, model, policy and developer instructions, plus `excludeTurns` when
  supported. Before any turn starts, the response must report the same thread id, the
  same effective model and the bounded policy. Then `turn/start` runs on that thread
  with your raw edit prompt. Codex's own persisted thread history is what carries the
  earlier image context (`excludeTurns` only omits history from the resume response,
  not from the thread).
- **Outputs.** For every image job, including the fallbacks below, only events tagged
  with both the current thread and the current turn are used, including events that
  arrive before the `turn/start` response. Events from other threads or earlier turns,
  events without ids, and resume history are never read. Images are verified and
  copied exactly as for any image job. `codex_task_start` keeps its original matching.
- Native thread ids are never returned and never accepted. Existing native threads are
  never listed or resumed.

## Limits

| limit | value |
|---|---|
| retained sessions per server process | 8 (the least recently used is evicted) |
| idle time to live | 30 min |
| successful turns per session | 8 |
| cumulative user prompt characters per session | 128 000 |

Sessions live only in the memory of the current MCP server handler/process, so a
restart invalidates every handle. MCP does **not** guarantee one process per Claude
conversation, and process isolation is not identity authentication. A handle is an
unguessable bearer capability scoped to that process and to the session's cwd/project:
whoever holds it can continue the thread. Do not share or reuse a handle across
unrelated Claude conversations. Every continuation must also match the session's cwd,
output root, Codex launcher, bridge mode and launch policy, and the default model from
`model/list` must not have changed. `codex_status` reports `image_sessions`
(continuity, retained count, limits).

## Errors

Nothing is retried automatically. Rejections returned directly by
`codex_image_generate` (`SESSION_UNKNOWN`, `SESSION_EXPIRED`, `SESSION_INVALIDATED`,
`SESSION_ROLLOVER_REQUIRED`, and `SESSION_INCOMPATIBLE` for a context mismatch) reject
**this** request before any new turn. That says nothing about earlier jobs: the failed,
cancelled or timed-out job that invalidated a session may already have consumed quota
or produced a native image. Starting over with `fresh_session: true` and a
self-contained description is the user's explicit choice (for `SESSION_UNKNOWN`, omit
the handle instead; `action` is `omit_session_handle`).

| code | when |
|---|---|
| `SESSION_UNKNOWN` | the handle was never issued by this process (for example after a restart) |
| `SESSION_EXPIRED` | idle for more than 30 min, or evicted by the cap |
| `SESSION_INVALIDATED` | the session's last job failed, was cancelled, timed out or was reset |
| `SESSION_ROLLOVER_REQUIRED` | the turn or prompt-character budget is used up |
| `SESSION_INCOMPATIBLE` | different cwd/root/launcher/mode/policy (checked before a job starts), or a changed model (the job fails before any turn) |
| `SESSION_STALE` | the native thread is gone, or resume reported another thread id |
| `THREAD_RESUME_FAILED` | another `thread/resume` error |

`SESSION_STALE`, `THREAD_RESUME_FAILED` and a model-change `SESSION_INCOMPATIBLE` are
job errors raised before that job's turn starts. Any cancel, timeout, shutdown, turn
failure, output-verification failure or other uncertain error revokes the handle; such
a job may have consumed quota or produced a native image before it failed. `BUSY` does
not affect the handle. `codex_task_status` on an image job reports the job's own error
code plus `session: {session_handle, usable, revoked_reason, rollover_reason, next_action}`.
`rollover_reason` is `max_turns` or `max_prompt_chars` once a live, unrevoked session has
used its whole turn or cumulative prompt budget; it is then `usable: false` with
`revoked_reason: null` and `next_action: fresh_session_required`. Otherwise it is `null`.

## Capability discovery and fallback

On the first image job, the server asks the configured Codex launcher for its stable
protocol schema (`codex app-server generate-json-schema --out <private temp dir>`):

- no shell and no model turn
- a 20 s timeout, with bounded output, file count, directory count and size; symlinks
  are rejected and never followed
- on timeout or output overflow, only the generator's own process group is killed; the
  server waits for it to exit before removing the temp dir
- the temp dir is always removed
- never `--experimental`

This probe runs inside the first `codex_image_generate` call, before the job response,
so it can delay that response by up to the 20 s discovery bound. No job ID exists yet,
so `codex_task_status` and `codex_task_cancel` cannot reach it. Server shutdown (MCP
close, stdin EOF, SIGINT, SIGTERM) can abort it: the generator's process group is
killed and reaped, the temp dir is removed, and shutdown waits for both. The pending
call returns `SHUTTING_DOWN` and starts no generation. A cancelled probe is not cached
and does not count as "unavailable". Once shutdown has begun, every later
`codex_task_start` or `codex_image_generate` returns `SHUTTING_DOWN` before any session
change, discovery or app-server spawn.

Methods are read from the generated `ClientRequest` union, and parameter fields from
each method's params schema. A field that must be a string or boolean counts only if
the schema declares that type. There is no version allowlist. The result is cached for
the lifetime of the handler. The method names used here (`thread/start`,
`thread/resume`, `turn/start`, `thread/name/set`) match the installed stable schema;
an old CLI whose schema lacks them simply gets the new-thread fallback.

- Continuity requires `thread/start.developerInstructions`, `thread/resume` with
  `threadId`, `cwd`, `model`, `approvalPolicy`, `approvalsReviewer`, `sandbox` and
  `developerInstructions`, and `turn/start` with its policy fields.
- If continuity is not proven, image generation still works on a new thread:
  `session_handle` is `null` and `session` is `{continuity: "unavailable", reason}`.
  Without native developer instructions, the earlier prompt wrapper is used instead.

The schema only shows what the protocol accepts. It does not prove what the native
sandbox enforces. This remains a trusted-local convenience, not a security boundary
(see [reference](reference.md)).
