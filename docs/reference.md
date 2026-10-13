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
- **Approvals are not bridged.** Any approval request (command, file change,
  permissions), MCP elicitation, user-input request, dynamic tool call or auth refresh is
  denied; the turn is interrupted, the process terminated, and the job fails with a typed
  error such as `APPROVAL_REQUIRED` plus a coarse `request_kind`. Writes inside `cwd`
  need no approval.
- Result text is Codex output and may contain sensitive material from your workspace.

## Image saving

- Images are taken **only** from native `imageGeneration` items' `savedPath`, never from
  caller-supplied paths. Each `savedPath` must be an absolute, normalized path under the
  Codex home (`$CODEX_HOME` or `~/.codex`) and a regular, single-link PNG/JPEG with no
  symlink components (O_NOFOLLOW, lstat/fstat comparison, signature check, 32 MiB cap).
- Bytes are copied with O_EXCL/O_NOFOLLOW/0600 into one fresh owned
  `<root>/<uuid>/` directory as `<uuid>.png|jpg`, with SHA-256 reported per file.
  Identical `savedPath`s are copied once. At most 8 image items per turn.
- The output root comes from one resolver shared by the server and installer:
  `CODEX_IMAGE_OUTPUT_ROOT` if set, else `~/codex-images`. An explicit empty, relative,
  non-normalized, NUL-containing or `/` value is `OUTPUT_ROOT_INVALID`: `codex_status`
  reports it (with a fixed reason, never the raw value) and both job tools refuse to
  start. Before any write, every existing path component must be a real directory (no
  symlinks) and the final root an owned directory; otherwise `OUTPUT_ROOT_UNAVAILABLE`.
- Any image item with no `savedPath`, a status other than `completed`, or beyond the
  8-item bound fails the job with `IMAGE_ITEM_INVALID`; a file that does not verify fails
  it with `IMAGE_VERIFICATION_FAILED`. Nothing is silently dropped. On any failure,
  timeout or cancel, the owned `<uuid>/` directory is removed after in-flight writes
  finish, and the job stays `BUSY` until then.
- The output root is written by this server process only; it is never added to Codex's
  writable roots.
- Path-check caveat: these checks narrow but cannot eliminate races with other processes
  running as your user. `cwd` is validated only at start.

## Tools

| tool | input | notes |
|---|---|---|
| `codex_status` | `{}` | CLI version, launch policy, plugin and MCP server names (bounded, sanitized), `image_generate_enabled`, `image_output: {root, source: "default"\|"env", error}`. |
| `codex_task_start` | `{prompt, cwd}` | `cwd`: absolute, normalized, existing directory, no symlinks, not `/`, `$HOME` or an ancestor. Returns `job_id`. Succeeded result: `{text, text_truncated, image_items, files: [{path, mime_type, bytes, sha256}]}`; `files` is `[]` when no image was produced. |
| `codex_task_status` | `{job_id}` | `running` / `succeeded` / `failed` / `cancelled`, result or typed error. |
| `codex_task_cancel` | `{job_id}` | Interrupts the turn and kills the process. |
| `codex_image_generate` | `{prompt, cwd}` | Asks Codex for one native image. Succeeded result: `{job_id, files: [{path, mime_type, bytes, sha256}], codex_version}`. A text-only completion is `NO_IMAGE_PRODUCED`. No editing tool. |

Limits: 300 s per job by default (`CODEX_TASK_WALL_SECONDS`, capped at 600), one active
job, 20 retained finished jobs, 64 KiB result text, 8 MiB per JSON-RPC frame (an
`imageGeneration` item carries the image inline as base64, ~1.33× the PNG size), 64 MiB
stdout per app-server process. Stderr is never read. The bridge **never retries**
requests, turns or generations (Codex internals may still retry transport).

Error codes: `APPROVAL_REQUIRED`, `UNSUPPORTED_SERVER_REQUEST`, `AUTH_REQUIRED`,
`QUOTA_EXCEEDED`, `TIMEOUT`, `CANCELLED`, `INITIALIZE_FAILED`, `MODEL_UNAVAILABLE`,
`POLICY_MISMATCH`, `THREAD_START_FAILED`, `TURN_START_FAILED`, `TURN_FAILED`,
`TURN_INTERRUPTED`, `PROTOCOL_ERROR`, `PROCESS_EXITED`, `OUTPUT_LIMIT`, `SPAWN_FAILED`,
`NO_IMAGE_PRODUCED`, `IMAGE_ITEM_INVALID`, `IMAGE_VERIFICATION_FAILED`,
`OUTPUT_ROOT_INVALID`, `OUTPUT_ROOT_UNAVAILABLE`.

## Model selection

Each job calls the read-only `model/list` on its own app-server and passes the single
entry advertised with `isDefault: true` as `model` to the new `thread/start`. Without
this, the thread inherits the model from your Codex config, which can be one your account
cannot use. There is no model input, no hard-coded id and no fallback; no default,
several defaults or a malformed list fails with `MODEL_UNAVAILABLE` before any thread.

## Protocol

Written against the `codex-cli 0.156.0` app-server schema. The protocol is evolving;
other Codex versions may fail (e.g. `PROTOCOL_ERROR`). The experimental API is not
enabled.
