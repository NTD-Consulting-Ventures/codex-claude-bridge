# Security model, tools and protocol

## Trust model: a capability, not a security boundary

- The delegated `prompt` runs as a **general Codex agent** using your normal Codex home,
  config, login, trust settings, plugins, hooks and MCP servers. Plugins, hooks and MCP
  servers are trusted-local; the sandbox does not contain them. Only send prompts you
  would type into Codex yourself. Paid plugins may spend money.
- Every job uses a **new** app-server process and a **new** thread (no resume/fork), with
  the model `model/list` advertises as default. `thread/start` sends `cwd`,
  `approvalPolicy: "on-request"`, `approvalsReviewer: "user"` and
  `sandbox: "workspace-write"`. `turn/start` sends an explicit `sandboxPolicy` of
  `{type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true}`:
  `cwd` is the only writable root, there is no network, and `/tmp` / `$TMPDIR` are not
  writable roots.
- **Policy check before the turn.** The effective policy reported by `thread/start` must
  be `cwd`, `on-request`, reviewer `user`, `workspaceWrite`, network not enabled, and
  `writableRoots` empty or exactly `[cwd]`. Anything else fails with `POLICY_MISMATCH`
  before `turn/start`. See [workspace-write-verification.md](workspace-write-verification.md).
- No bypass/dangerous flags and no `--config` overrides. The server never reads
  `auth.json`/`config.toml`, never logs in, never extracts tokens and never falls back to
  an API key.
- **Approvals follow the approval mode** ([approvals.md](approvals.md)). Approval requests
  (command, file change, permissions) of the job's own thread and turn are, depending on
  `CODEX_APPROVAL_MODE`: paused until you decide in Claude Code (`ask`, the default),
  accepted automatically (`bypass`, opt-in), or denied so the job fails with
  `APPROVAL_REQUIRED` (`deny`). Only one-time, turn-scoped decisions are sent; no session
  approvals, no policy amendments. Every other server-initiated request (MCP elicitation
  from Codex's MCP servers, user-input request, dynamic tool call, auth refresh) is still
  denied: the turn is interrupted, the process terminated, and the job fails with
  `UNSUPPORTED_SERVER_REQUEST` plus a coarse `request_kind`. Writes inside `cwd` need no
  approval.
- Result text is Codex output and may contain sensitive material from your workspace.

## Image saving

- Images are taken **only** from native `imageGeneration` items' `savedPath`, never from
  caller-supplied paths. Each `savedPath` must be an absolute, normalized path under the
  Codex home (`$CODEX_HOME` or `~/.codex`) and a regular, single-link PNG/JPEG with no
  symlink components (O_NOFOLLOW, lstat/fstat comparison, signature check, 32 MiB cap).
- Bytes are copied with O_EXCL/O_NOFOLLOW/0600 into one fresh owned
  `<root>/<uuid>/` directory per job as `<uuid>.png|jpg`, with SHA-256 reported per file.
  Each file also reports `index` (the order Codex reported it in), `width`, `height` and
  `has_alpha` from its header. Identical `savedPath`s are copied once. At most 8 images
  per job.
- **Incremental.** Each completed image is verified and copied as soon as Codex reports
  it, one at a time; a running job lists the copies in `progress.files_so_far`. A copy that
  fails is tried once more after the turn (Codex may report an image a moment before its
  file is complete) before the job is judged.
- **Partial results.** When a job fails, times out or is cancelled, nothing that was
  verified and completely written is removed. After the failure the bridge also saves
  completed images it had not copied yet (the abort only stops copying while the job is
  still running), and images Codex saved into `generated_images/<thread>/` at or after
  the turn start without reporting them; those are matched by location and time only,
  must be complete (a PNG must end with its IEND chunk) and are labelled
  `source: "thread_folder"`; for a resumed image thread only files from the turn start on
  count, so the session's earlier images are not picked up. All of them are reported as `partial_files` on the failed or
  cancelled job (an empty list when there are none). Unverified or partially written
  files and an empty job directory are removed. Once the server starts shutting down
  nothing more is written, salvage included. The job stays `BUSY` until every filesystem step has finished.
- Success still requires every reported image item to verify: an item with no
  `savedPath`, a status other than `completed`, or beyond the 8-item bound fails the job
  with `IMAGE_ITEM_INVALID`; a file that does not verify fails it with
  `IMAGE_VERIFICATION_FAILED`. The images that did verify are its `partial_files`.
- The output root comes from one resolver shared by the server and installer:
  `CODEX_IMAGE_OUTPUT_ROOT` if set, else `~/codex-images`. An explicit empty, relative,
  non-normalized, NUL-containing or `/` value is `OUTPUT_ROOT_INVALID`: `codex_status`
  reports it (with a fixed reason, never the raw value) and both job tools refuse to
  start. Before any write, every existing path component must be a real directory (no
  symlinks) and the final root an owned directory; otherwise `OUTPUT_ROOT_UNAVAILABLE`.
- The output root is written by this server process only; it is never added to Codex's
  writable roots.
- Path-check caveat: these checks narrow but cannot eliminate races with other processes
  running as your user. `cwd` is validated only at start (a queued job re-checks `cwd`
  and its reference images when it starts).

## Reference images

`reference_images` (on `codex_image_generate` and `codex_task_start`) is a list of 1–8
paths relative to `cwd` (or absolute inside it). Each must resolve inside `cwd` with no
symlink component and be a regular, single-link PNG or JPEG of at most 20 MiB (64 MiB
total), checked by signature with the same read checks as above. Valid files are sent to
Codex as native `localImage` turn inputs (absolute paths, after the text input). Codex
reads them itself; the bridge never copies, writes or returns them. A rejected entry
fails the call with `REFERENCE_IMAGE_INVALID` plus its `index` and a fixed `reason`
(`invalid_path`, `outside_cwd`, `not_found`, `symlink`, `not_a_file`, `hard_linked`,
`too_large`, `total_too_large`, `not_png_or_jpeg`, `changed_while_reading`, `duplicate`)
before any job exists.

References are only sent when the installed Codex schema lists the `localImage` variant of
the turn input (the same schema discovery as [image sessions](image-sessions.md)); if it
does not, the call fails with `REFERENCE_IMAGES_UNSUPPORTED` before any job. With
codex-cli 0.162.1 the schema lists it, and the app-server accepted the input and echoed it
in the user message (checked live, signed out; what the model does with references was not
verified by the maintainers). The image thread's developer instructions tell Codex that
attached images are visual references for the request. The path checks run at start time
only.

## Tools

| tool | input | notes |
|---|---|---|
| `codex_status` | `{}` | CLI version, launch policy, plugin and MCP server names (bounded, sanitized; the last good listing is shown with `stale: true` and `cached_at` when a later probe fails), `image_generate_enabled`, `image_output: {root, source: "default"\|"env", error}`, `runtime: {codex_bin, codex_bin_source, codex_launcher: "native"\|"node_shebang"\|"other_script"\|"unknown"\|"missing"\|"invalid", node_path, node_version, node_dir_on_child_path}`, `limits`, `active_job_id`, `queued_job_ids`, `last_job: {job_id, kind, state, finished_at, error_code, likely_cause, partial_files}`, `approvals: {mode, source, env_issue, timeout_s, claude_code_dialog}`, `reference_images: {support, max_count, max_bytes_each, max_total_bytes}`, `image_sessions`. The listing runs under one 10 s budget in parallel with the 5 s version check. |
| `codex_task_start` | `{prompt, cwd, timeout_s?, queue?, reference_images?, approval_mode?}` | `cwd`: absolute, normalized, existing directory, no symlinks, not `/`, `$HOME` or an ancestor. Returns `job_id`, `state` (`running` or `queued`), `timeout_s`. Succeeded result: `{text, text_truncated, image_items, files: [{path, mime_type, bytes, sha256, index, width, height, has_alpha}]}`; `files` is `[]` when no image was produced. |
| `codex_task_status` | `{job_id}` | `queued` / `running` / `awaiting_approval` / `succeeded` / `failed` / `cancelled`; `timeout_s`; while running `progress: {phase, images_completed, files_so_far, first_model_event_ms, last_event_at}`; while awaiting approval `pending_approvals`; while queued `queue_position`; `approvals` (decision log) once there was a request; when finished the result or a typed error plus `partial_files`. With Claude Code dialog support, opens the approval dialog of a pending request during the call. |
| `codex_task_approve` | `{job_id, approval_id, decision: "accept" \| "decline"}` | Answers one pending approval request. Marked `anthropic/requiresUserInteraction`, so Claude Code asks the user to confirm every call. `APPROVAL_NOT_PENDING` when it was already decided, timed out or is unknown. |
| `codex_task_wait` | `{job_id, max_wait_s?}` | Waits up to `max_wait_s` (1–120, default 30) for the job to finish or to need an approval, then returns the same view as `codex_task_status` plus `waited_ms`. |
| `codex_task_cancel` | `{job_id}` | A queued job is cancelled at once; a running one has its turn interrupted and its process killed. Already generated images are kept (`partial_files`). |
| `codex_image_generate` | `{prompt, cwd, session_handle?, fresh_session?, aspect?, timeout_s?, queue?, reference_images?, approval_mode?}` | Asks Codex for one native image. Succeeded result: `{job_id, files: [...], codex_version, session_handle, session}`. A text-only completion is `NO_IMAGE_PRODUCED`. `aspect` (`1:1`, `4:3`, `3:2`, `16:9`, `2:1`, `3:4`, `2:3`, `9:16`, `1:2`) appends a fixed "Output format: …" line to the prompt; the native tool still picks the pixel size. Follow-up edits via an explicit bridge-issued `session_handle` ([image sessions](image-sessions.md)), or a fresh job with the earlier file in `reference_images`. `queue` cannot be combined with `session_handle`. |

Limits: 300 s per job by default (`CODEX_TASK_WALL_SECONDS`, capped at 900; per job
`timeout_s` 10–900), one running job plus up to 8 queued (opt-in `queue: true`, otherwise
`BUSY`), 20 retained finished jobs, 64 KiB result text, 8 images per job, 8 MiB per
JSON-RPC frame (an `imageGeneration` item carries the image inline as base64, ~1.33× the
PNG size), 64 MiB stdout per app-server process. Stderr is never read. The bridge **never
retries** requests, turns or generations (Codex internals may still retry transport).

Error codes: `APPROVAL_REQUIRED`, `UNSUPPORTED_SERVER_REQUEST`, `AUTH_REQUIRED`,
`QUOTA_EXCEEDED`, `TIMEOUT`, `CANCELLED`, `INITIALIZE_FAILED`, `MODEL_UNAVAILABLE`,
`POLICY_MISMATCH`, `THREAD_START_FAILED`, `TURN_START_FAILED`, `TURN_FAILED`,
`TURN_INTERRUPTED`, `PROTOCOL_ERROR`, `PROCESS_EXITED`, `OUTPUT_LIMIT`, `SPAWN_FAILED`,
`NO_IMAGE_PRODUCED`, `IMAGE_ITEM_INVALID`, `IMAGE_VERIFICATION_FAILED`,
`OUTPUT_ROOT_INVALID`, `OUTPUT_ROOT_UNAVAILABLE`, `REFERENCE_IMAGE_INVALID` (a queued
job's references changed before it started). Tool-call errors: `INVALID_ARGUMENTS`,
`INVALID_CWD`, `BUSY`, `QUEUE_FULL`, `REFERENCE_IMAGE_INVALID`, `APPROVAL_NOT_PENDING`,
`REFERENCE_IMAGES_UNSUPPORTED`, `UNKNOWN_JOB`, `UNKNOWN_TOOL`, `TOOL_DISABLED` (a tool not
exposed in the current `CODEX_BRIDGE_MODE`), `SHUTTING_DOWN` (the server is stopping;
no job was started and no job ID exists).

## Error hints and turn timing

Every job error carries `retryable` and `likely_cause`, derived by a fixed mapping
(`src/error-hints.ts`) from the code and the whitelisted diagnostic enums only. They are
hints for the caller's decision, not a root cause; the bridge never retries. A failure
that was determined before a cancel or the deadline (for example a policy rejection)
stays the reported error even if the cancel or deadline arrives while images are still
being salvaged.

| `likely_cause` | when | `retryable` |
|---|---|---|
| `network` | `TURN_FAILED` with a connection error, or a `TIMEOUT` while Codex kept retrying one | true |
| `server` | server or overload errors (also as the last retried error before a timeout) | true |
| `slow_generation` | `TIMEOUT` in the turn after images completed or while events still arrived, or after the turn finished (`phase: "saving"`) | true |
| `no_model_response` | `TIMEOUT` in the turn with no model event at all | true |
| `stalled` | `TIMEOUT` in the turn, last event more than 60 s before the deadline | true |
| `startup` | timeout or RPC failure before the turn (`initialize`, `thread/start`, `turn/start`) | true |
| `rate_limit` / `quota` | `QUOTA_EXCEEDED` (rate limit vs. usage limit) | true / false |
| `auth`, `approval`, `policy`, `config`, `session`, `request`, `content_policy` | the matching codes | false |
| `no_image`, `interrupted`, `local`, `cancelled`, `unknown` | as named | see `src/error-hints.ts` |

Turn-phase `TIMEOUT`, `TURN_FAILED`, `PROCESS_EXITED`, `CANCELLED` and `TURN_INTERRUPTED`
diagnostics add `images_completed` (when > 0), `first_model_event_ms` (from `turn/start`
to the first `item/*` event other than the echoed user message; `null` if none),
`last_event_ms_ago`, `retried_errors`, and `last_retry_error_info` /
`last_retry_message_class` for the last error Codex retried. Captured from codex-cli
0.162.1 without network: the turn keeps emitting `error` notifications with
`willRetry: true` ("Reconnecting… waiting for network",
`responseStreamDisconnected`) until the deadline, so such a timeout reads as `network`.

## Bridge mode

`CODEX_BRIDGE_MODE` (unset = `general`, or `image-only`) is resolved once at server
start and reported by `codex_status` as `bridge_mode`. `image-only` lists only
`codex_status`, `codex_image_generate`, `codex_task_status`, `codex_task_wait`,
`codex_task_approve` and `codex_task_cancel`, and
refuses direct `codex_task_start` calls with `TOOL_DISABLED`; it narrows the MCP tool
surface only and does not change native Codex capabilities or the launch policy above. See
[image-only.md](image-only.md).

## Model selection

Each job calls the read-only `model/list` on its own app-server and passes the single
entry advertised with `isDefault: true` as `model` to the new `thread/start`. Without
this, the thread inherits the model from your Codex config, which can be one your account
cannot use. There is no model input, no hard-coded id and no fallback; no default,
several defaults or a malformed list fails with `MODEL_UNAVAILABLE` before any thread.

## Protocol

Written against the `codex-cli 0.156.0` app-server schema; reference-image input and the
turn timing were checked against the generated 0.162.1 schema and a signed-out 0.162.1
app-server. The protocol is evolving;
other Codex versions may fail (e.g. `PROTOCOL_ERROR`). The experimental API is not
enabled.
