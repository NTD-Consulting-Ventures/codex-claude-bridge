# codex-image-mcp — trusted-local Codex delegation MCP server

A Node 22 TypeScript stdio MCP server that lets Claude Code (CLI, or Claude Desktop's
**local** Code environment) delegate tasks to the **locally installed, logged-in official
Codex CLI** on your own MacBook, via `codex app-server --listen stdio://` (JSON-RPC).
The name is historical; it is a general delegation server with an optional image helper.

## Status — read this first

- Fixture tests, lint, typecheck and build pass. Live runs (see
  [`docs/runtime-verification.md`](docs/runtime-verification.md)): `codex_status` and a
  read-only `PONG` task succeeded. The single authorized image smoke generated exactly one
  native image but the MCP job **failed with `OUTPUT_LIMIT`**; the frame bound was then
  raised to 8 MiB and the image was recovered read-only via `thread/read` (hash-verified).
  The repaired image path has **not** been re-run live, so end-to-end image success is
  not demonstrated. Image editing is not offered.
- Protocol support was written against the installed `codex-cli 0.156.0` generated schema
  and source. The app-server protocol is evolving; other Codex versions may break this.
  The experimental API is **not** enabled (none of the methods used require it).

## Trust model — this is a capability, not a security boundary

- The delegated `prompt` runs as a **general Codex agent** using your normal Codex home,
  config, login, trust settings, plugins and MCP servers. Anything they can do under the
  native policy, a prompt can ask for. Only send prompts you would type into Codex yourself.
- Every thread is **new** (no resume/fork of existing sessions) and is started with
  `approvalPolicy: "on-request"` and `sandbox: "read-only"`. No bypass / dangerous flags
  and no `--config` overrides are used; this server never reads `auth.json`/`config.toml`
  and never logs in, extracts tokens, or falls back to an API key.
- **Native approvals are not bridged to an interactive UI.** Any approval request (command,
  file change, permissions), MCP elicitation, user-input request, dynamic tool call or auth
  refresh is **denied** with a JSON-RPC error (no fabricated answer), the turn is interrupted,
  the process terminated, and the job fails with a typed error such as `APPROVAL_REQUIRED`
  plus a coarse `request_kind` (never the raw request).
- Plugins/MCP servers configured in Codex remain usable inside the native sandbox/approval
  policy; paid plugins may spend money — that is your responsibility.
- Task result text is Codex output and may contain sensitive material from your workspace.

## Tools

| tool | input | notes |
|---|---|---|
| `codex_status` | `{}` | CLI version, launch policy, installed plugin names (`plugin/installed`) and MCP server names (`mcpServerStatus/list` with `detail: "toolsAndAuthOnly"`, `limit: 50`, at most 4 pages / 100 names). Each listing has `truncated` (a local bound dropped entries) and `has_more` (peer still had a next page; `null` if unknown). A failed method gives `available:false` + a reason made only of fixed enums (e.g. `mcpServerStatus/list failed: rpc invalid_request/experimental_api_required`). No URLs/paths/accounts/tool schemas. |
| `codex_task_start` | `{prompt, cwd}` | `cwd`: absolute, normalized, existing directory, no symlinks, not `/` or `$HOME`. Returns `job_id`. Single active job; `BUSY` otherwise. |
| `codex_task_status` | `{job_id}` | `running` / `succeeded` / `failed` / `cancelled`, result or typed error. |
| `codex_task_cancel` | `{job_id}` | Interrupts the turn and kills the process. |
| `codex_image_generate` | `{prompt, cwd}` | Listed only if `CODEX_IMAGE_OUTPUT_ROOT` is set. Success **only** if a native `imageGeneration` item reports a `savedPath` under the Codex home that verifies as a regular PNG/JPEG (signature, size, no symlinks, single link); bytes are copied to `<root>/<uuid>/<uuid>.png`. Succeeded result: `{job_id, files: [{path, mime_type, bytes, sha256}], codex_version}`. A text-only completion is `NO_IMAGE_PRODUCED`. No image editing tool. |

Limits: wall clock 300 s per job by default (`CODEX_TASK_WALL_SECONDS`, capped at 600),
20 retained finished jobs, 64 KiB result text, 8 MiB per JSON-RPC frame (a completed
`imageGeneration` item carries the image inline as base64, so its frame is ~1.33× the
PNG size), 64 MiB stdout per app-server process. Stderr is never read: past 1 MiB it is
dropped and only counted, and it does not fail the job.
The bridge **never retries** requests, turns or generations (Codex's own internals may
still retry transport). Error codes: `APPROVAL_REQUIRED`, `UNSUPPORTED_SERVER_REQUEST`,
`AUTH_REQUIRED`, `QUOTA_EXCEEDED`, `TIMEOUT`, `CANCELLED`, `TURN_FAILED`,
`TURN_INTERRUPTED`, `PROTOCOL_ERROR`, `PROCESS_EXITED`, `OUTPUT_LIMIT`, `SPAWN_FAILED`,
`NO_IMAGE_PRODUCED`, `IMAGE_VERIFICATION_FAILED`, `MODEL_UNAVAILABLE`.

Model selection: each job calls the read-only `model/list` on its own app-server and
passes the single entry advertised with `isDefault: true` as `model` to the NEW
`thread/start`. Without this, the thread inherits the model from your normal Codex
config, which can be one your account cannot use (observed: HTTP 400 "model is not
supported when using Codex with a ChatGPT account"). The selection is per-thread only:
config, home, plugins and auth are not read or changed. There is no model input, no
hard-coded id and no fallback; no default, several defaults, a malformed id or an
invalid list shape fails with `MODEL_UNAVAILABLE` (`diagnostic.model_selection`)
before any thread or turn is started.

Path-check caveat: the file checks narrow but cannot eliminate TOCTOU races with other
processes running as your user; `cwd` is validated only at start.

## Prerequisites

- macOS, Node ≥ 22, official Codex CLI logged in normally (`codex login`) and the project
  directory trusted in your normal Codex config. The server uses `~/.local/bin/codex` unless
  `CODEX_BIN` is set to an absolute, normalized path (e.g. `/opt/homebrew/bin/codex`). An
  invalid `CODEX_BIN` fails closed; it never falls back to another location.

## Development

```sh
npm install
npm run lint        # ESLint (typescript-eslint)
npm run typecheck
npm test            # build + node:test; fixtures only, never spawns Codex
npm run build
```

## Registering with Claude Code

`npm run register` prints the official command (dry run); `npm run register -- --apply` runs
`claude mcp add --transport stdio --scope user [-e CODEX_BIN=…] [-e CODEX_IMAGE_OUTPUT_ROOT=…] codex-image-mcp -- <abs node> <abs dist/src/server.js>`.
It never edits `~/.claude.json` directly and never overwrites: it first runs
`claude mcp get codex-image-mcp` and proceeds only on exit 1 with the exact not-found output
of `claude` 2.1.293 (`No MCP server named "codex-image-mcp". Configured servers: …`) on exactly
one stream (the CLI uses stderr; output on both streams is rejected). An
existing server of that name in any scope (exit 2) or any other output (exit 3) stops it.
Export `CODEX_IMAGE_OUTPUT_ROOT=<absolute dir>` before running it to enable the image tool;
an invalid value fails closed.

## Setting up on a second MacBook

Each Mac uses its own local tools and its own login; nothing is copied between machines.

1. Install Node ≥ 22 and the official Codex CLI (tested: 0.156.0), then run `codex login`
   yourself and trust the project directory in your normal Codex config.
2. `git clone <repo> && cd codex-image-mcp && npm ci && npm run build`
3. Optional: `export CODEX_IMAGE_OUTPUT_ROOT=/Users/<you>/codex-images` (and `CODEX_BIN` if
   Codex is not at `~/.local/bin/codex`).
4. `npm run register` (dry run), review, then `npm run register -- --apply`.
5. Use it from Claude Code CLI or Claude Desktop's **local** Code environment. Remote/cloud
   Code sessions cannot reach your local Codex and are not supported.

## Live smoke (parent-controlled, not part of `npm test`)

```sh
npm run build
node scripts/smoke.mjs status
node scripts/smoke.mjs task                               # read-only "PONG" task
node scripts/smoke.mjs image --confirm-spend-one-image    # ONE real generation, no retry
```

Each run uses a git-ignored `.smoke/<uuid>/` workspace and writes `evidence.json` there.

## License

MIT
