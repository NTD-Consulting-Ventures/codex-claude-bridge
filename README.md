# codex-image-mcp

**Let Claude Code hand tasks to the official Codex CLI on your own Mac.**

codex-image-mcp is a small local MCP server. Once it is registered, Claude Code can ask
the Codex CLI that you installed and signed in to yourself to work on a task in a folder
you choose, and then report back the result. It can also save images that Codex
generates, but that is optional and off by default. (The name is historical. This is a
general delegation server with an optional image helper.)

- **Runs only on your Mac.** It works with the Claude Code CLI and with Claude Desktop's
  **Local** Code environment. Cloud/remote Code sessions, Claude on the web and iPad
  cannot reach the Codex on your Mac, so they are not supported. This server is not
  designed to be hosted anywhere.
- **Uses your own sign-ins.** Codex and Claude each use the account you sign in with
  yourself. Nothing is copied between tools or machines, and there is no API-key fallback.
- **Writes only inside the folder you give it.** Codex may create and change files inside
  the task's `cwd` folder without asking, with no network access. Anything beyond that
  (writing elsewhere, network, extra permissions) would need an approval, and the job
  stops instead; nothing approves it on your behalf. See
  [What it can and cannot do](#what-it-can-and-cannot-do).

## Before you start

You need:

- **A Mac (macOS)** with Terminal access. Everything runs locally.
- **Node.js 22 or newer.** Get it from the official download page,
  <https://nodejs.org/en/download>. You can check your version with `node --version`.
- **The official Codex CLI.** Follow the official quickstart at
  <https://github.com/openai/codex#quickstart>, for example `npm install -g @openai/codex`.
  After that, sign in yourself with `codex login`. In your normal Codex settings, trust
  the folders you plan to delegate work in.
- **Official Claude Code.** Use the native install described at
  <https://code.claude.com/docs/en/setup>. After that, sign in yourself with
  `claude auth login` and check that it worked with `claude auth status`.
- **git**, so you can clone this repository.

Never copy authentication tokens, `auth.json`, `config.toml`, `~/.claude.json` or other
credential or config files from another Mac or another person. Each Mac signs in on its
own. This project never reads those files, never signs in for you, and never falls back to
an API key.

This project was tested with Codex CLI **0.156.0** and Claude Code **2.1.293**. Other
versions might also work (see [Troubleshooting](#troubleshooting)).

## Install

### 1. Get the code and build it

```sh
git clone https://github.com/NTD-Consulting-Ventures/codex-image-mcp.git
cd codex-image-mcp
npm ci
npm run build
```

Choose a permanent location for the clone, such as `~/Code/codex-image-mcp`. Claude
records the **absolute path** to the built server, so moving, renaming or deleting this
folder will break the registration. If you do move it, register it again from the new
location.

### 2. Find the real `claude` and `codex` programs

Claude Desktop and MCP servers don't start with your Terminal's shell setup. That means
aliases, shell functions and PATH changes from your `~/.zshrc` may not be available to
them. To avoid this, give the setup the **absolute, normalized path of the real
executable**, never an alias or a function.

First, see what your shell finds:

```sh
type -a claude      # every match, including aliases and functions
type -a codex
command -v claude   # the first match
command -v codex
```

You want an entry that is a file path starting with `/`. If the first match is an alias
or a function, find the real program path in the `type -a` output and use that path in
place of `$(command -v …)` below.

Next, resolve each path to its real file (following symlinks) using Node's
`fs.realpathSync`, and export it. Keep the double quotes, because paths can contain
spaces:

```sh
export CLAUDE_BIN="$(P="$(command -v claude)" node -e 'process.stdout.write(require("node:fs").realpathSync(process.env.P))')"
export CODEX_BIN="$(P="$(command -v codex)" node -e 'process.stdout.write(require("node:fs").realpathSync(process.env.P))')"
echo "$CLAUDE_BIN"
echo "$CODEX_BIN"
"$CLAUDE_BIN" --version
"$CODEX_BIN" --version
"$CLAUDE_BIN" auth status
```

What these variables do:

- `CODEX_BIN` is stored in the registration, and the server uses it to start Codex. If you
  don't set it, the server uses exactly `~/.local/bin/codex` and nothing else.
- `CLAUDE_BIN` decides which `claude` the setup script uses. If you don't set it, the
  script uses the first `claude` on your PATH.
- If either variable is set but is not an absolute, normalized path, setup stops with an
  error. It never quietly falls back to a different location.
- If a resolved path contains a version number, it may change after an update. Check it
  again after upgrading (see [Troubleshooting](#troubleshooting)).

### 3. Preview the registration (dry run)

Run this from the clone, in the same Terminal session where you exported the variables:

```sh
npm run register
```

This prints the exact `claude mcp add` command and changes nothing. The dry run still
asks Claude (`claude mcp get codex-image-mcp`) whether the name is already in use. If a
server with that name exists, or if the answer is unclear, it stops. Before you continue,
check the printed paths. The registration records the absolute path of the `node` that
runs this script, so run it with the Node 22+ installation you plan to keep.

> **First-ever MCP setup:** if Claude Code has **no MCP servers configured at all**, the
> dry run (and `--apply`) stops with **exit 3 (inconclusive)**. This is expected. With an
> empty config, Claude 2.1.293 answers `claude mcp get` with a different "not found"
> message than the one the script recognizes, and the script deliberately treats any
> unrecognized answer as inconclusive. Nothing was changed. In that case, use the
> [manual fallback](#manual-fallback) below, which covers this case.

### 4. Register

```sh
npm run register -- --apply
```

This adds `codex-image-mcp` to your Claude Code **user** scope through the official
`claude` CLI. It never edits Claude's config files directly and never overwrites an
existing entry.

Exit codes the **script itself** returns. The failure exits 1, 2 and 3 are produced by
its preflight checks: they always happen **before** it prints the `Command: …` line, and
come with the script's own message. Exit 0 (success) comes **after** the `Command: …`
line, once the dry run or the `--apply` registration has finished:

| exit | meaning |
|---|---|
| 0 | registered (or, without `--apply`, the dry run passed) |
| 1 | not built, an invalid `CLAUDE_BIN` / `CODEX_BIN` / `CODEX_IMAGE_OUTPUT_ROOT`, or `claude` not found |
| 2 | a server named `codex-image-mcp` **already exists** in some scope (`… is already registered; not overwriting`); nothing changed |
| 3 | it was **inconclusive** whether the name is free (`Could not confirm …`), including the [first-ever MCP setup](#3-preview-the-registration-dry-run) case; nothing changed |

With `--apply`, once the `Command: …` line has been printed, the script runs
`claude mcp add` and exits with **whatever code `claude mcp add` returned** (or 1 if it
timed out or was killed). Such a code can also be 1, 2 or 3, but it is Claude's code, not
the script's, and the table above does **not** apply to it. In particular, "nothing
changed" is **not** guaranteed: the add may have written some or all of the
registration. Look at Claude's own message and check the result with
`"$CLAUDE_BIN" mcp get codex-image-mcp` before you try again.

If the script itself reports exit 2 or 3, **don't remove an existing configuration just
so the script can proceed.** It might be a setup that already works. See
[Troubleshooting](#troubleshooting).

#### Manual fallback

Use this only if the script can't be used, for example on a first-ever MCP setup where it
stops with exit 3. First, ask the official CLI whether the name is free, and check the exit
code **immediately afterwards** (any other command in between replaces `$?`):

```sh
"$CLAUDE_BIN" mcp get codex-image-mcp
echo $?
```

Then repeat it with error output hidden, to confirm nothing goes to stdout:

```sh
"$CLAUDE_BIN" mcp get codex-image-mcp 2>/dev/null
echo $?
```

Continue **only** if **all** of the following are true:

1. Both `echo $?` lines print exactly `1`.
2. The second command prints **nothing** before the `1`. Claude 2.1.293 writes the answer to
   stderr only, so exactly one stream (stderr) has output and stdout is empty.
3. The first command's entire output is **one** of these two shapes, with no warnings,
   errors or other lines mixed in before or after:
   - **Empty config** (verified with Claude 2.1.293 when no MCP servers exist), exactly
     this single line:

     ```text
     No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.
     ```

   - **Other servers configured:** it starts with exactly
     `No MCP server named "codex-image-mcp". Configured servers:` followed by the list of
     configured servers, and `codex-image-mcp` does **not** appear anywhere in that list.

If you see anything else (a different exit code, output on stdout, different wording, extra
warning or error text, or `codex-image-mcp` in the list), stop and see
[Troubleshooting](#troubleshooting).

If and only if all of the checks above passed, then from the clone, use the variables from
step 2:

```sh
NODE_BIN="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.execPath))')"
REPO_DIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.cwd()))')"
"$CLAUDE_BIN" mcp add --transport stdio --scope user codex-image-mcp \
  -e "CODEX_BIN=$CODEX_BIN" \
  -- "$NODE_BIN" "$REPO_DIR/dist/src/server.js"
```

- The name `codex-image-mcp` must come **before** any `-e`. Claude 2.1.293 lets `-e` take
  several values, so a name placed after it would be read as another env entry.
- `--` must come before the absolute `node` and server paths.
- Add `-e "CODEX_IMAGE_OUTPUT_ROOT=$CODEX_IMAGE_OUTPUT_ROOT"` (before `--`) **only** if
  you are enabling the [optional image tool](#optional-image-generation).
- If `mcp add` reports an error, don't assume nothing was written. Check with
  `"$CLAUDE_BIN" mcp get codex-image-mcp` before you try again.

## Check that it works

### Claude Code CLI

Open a new Terminal, go to the clone, and start a **new** Claude Code session:

```sh
cd /path/to/codex-image-mcp
pwd -P      # the absolute path to use as cwd below
claude      # or "$CLAUDE_BIN"
```

Type `/mcp` and confirm that `codex-image-mcp` is listed. Then ask Claude:

> Call the `codex_status` tool. Then call `codex_task_start` with `cwd` set to
> `"/absolute/path/from/pwd"` and the prompt `Reply with exactly PONG. Do not edit files or
> run commands.` Then poll `codex_task_status` with exactly the `job_id` that was returned
> until it is no longer `running`, and show me the result.

`codex_status` should show your Codex version, and the task should succeed with `PONG`.
This check makes no images and needs no paid plugins.

#### First writable test (create, then modify)

Codex can write inside the `cwd` folder, so use an **empty, throwaway folder** for this test,
never your home folder or a project you care about. In Terminal:

```sh
mkdir -p "$HOME/codex-write-test"
cd "$HOME/codex-write-test"
pwd -P      # the exact canonical path to use as cwd below (no symlinks, no trailing /)
```

Then ask Claude, using that exact path. Run one job at a time and wait for it to finish:

> Call `codex_task_start` with `cwd` set to `"/absolute/path/from/pwd"` and the prompt
> `Create receipt.txt containing exactly the text initial receipt followed by one newline.
> Do not change anything else.` Then poll `codex_task_status` with exactly the returned
> `job_id` until it is no longer `running`, and show me the result.

When that has succeeded, start a **second** job with the same `cwd`:

> Call `codex_task_start` with the same `cwd` and the prompt `Replace the contents of
> receipt.txt with exactly the text final receipt followed by one newline. Do not change
> anything else.` Then poll `codex_task_status` until it is no longer `running`.

Check the result yourself in Terminal with `cat receipt.txt`. Each job is a new Codex
thread, so the second one only knows about the file because it is on disk. No approval
should be asked for. If a job fails with `APPROVAL_REQUIRED` or `POLICY_MISMATCH`, see
[Troubleshooting](#troubleshooting). Delete the test folder when you are done.

### Claude Desktop (Local)

Quit Claude Desktop completely and open it again so it reloads MCP servers. Start a
**fresh** Code session using the **Local** environment, open the clone folder, check that
the server appears, and send the same prompt. Remote/cloud environments will not see this
server. Note that this project has **not yet independently verified** discovery in the
Desktop Local environment. The CLI flow above is the verified path.

## Optional: image generation

Image generation is off by default. To turn on `codex_image_generate`, choose an output
folder **before** you register:

```sh
mkdir -p "$HOME/codex-images"
export CODEX_IMAGE_OUTPUT_ROOT="$HOME/codex-images"   # absolute, normalized, not /
npm run register             # dry run, then:
npm run register -- --apply
```

If the server is already registered without an output folder, you can only enable images
by deliberately replacing your own registration ([Uninstall](#uninstall), then register
again).

Before you enable it, be aware of the following:

- **Every call is a real generation.** It may use up your Codex/ChatGPT plan allowance or
  cost money.
- **The bridge never retries.** This server never re-sends a failed request, turn or
  generation; you decide whether to try again. Codex's own native transport may still
  retry internally, outside this server's control.
- **A failed call can still cost.** Even if the job ends in an error, a generation may
  already have run (or been retried inside Codex) and used up allowance or money.
- **It is not proven end-to-end.** The only live image smoke test produced one native
  image, but the MCP job **failed with `OUTPUT_LIMIT`**. The limit was raised afterwards,
  and the image was recovered separately in read-only mode. That recovery is **not** a
  live success of the tool, and the fixed path has not been re-run live.
- **There is no image editing.** Generated files are copied to `<root>/<uuid>/<uuid>.png`.

## What it can and cannot do

- Every job starts a new Codex thread with a **workspace-write sandbox** whose **only**
  writable folder is the `cwd` you pass, with **no network** and with `/tmp` and `$TMPDIR`
  excluded. Codex can create, modify and delete files inside `cwd` without asking you.
  Pick `cwd` deliberately; `/`, your home folder and its parent folders are refused.
- **Approvals are not passed through to you.** Anything that needs permission (writing
  outside `cwd`, network, running commands that need approval, extra permissions,
  signing in) stops the job with an error such as `APPROVAL_REQUIRED`.
- The task still runs as a **general Codex agent** with your Codex config, plugins, hooks
  and MCP servers. Those are trusted-local and are **not** contained by the sandbox. Only
  send prompts you would type into Codex yourself.
- `codex_status` lists the plugins and MCP servers Codex reports. Being listed does not
  mean they have been tested with this bridge. Paid integrations are **unverified**, and
  any costs they incur are your responsibility.
- Only one job runs at a time, and each job has a default limit of 300 s.

For the full details, see the
[trust model](#trust-model--this-is-a-capability-not-a-security-boundary) and
[tools](#tools) reference below.

## Troubleshooting

- **`claude`/`codex` not found, the wrong one is used, or `SPAWN_FAILED`.** Run step 2
  again. Desktop and MCP servers don't use your shell's PATH, aliases or functions, so
  use absolute real paths. Without `CODEX_BIN`, the server only looks at
  `~/.local/bin/codex`. If an update moved the binary, replace your registration
  deliberately (see below) using the new path.
- **Version compatibility.** Tested versions are Codex CLI 0.156.0 and Claude Code
  2.1.293. The Codex app-server protocol is still evolving, so other versions may fail
  (for example with `PROTOCOL_ERROR`). The register script expects the exact "not found"
  text from Claude 2.1.293; if that text changes, the script reports exit 3. Compare
  `"$CODEX_BIN" --version` and `"$CLAUDE_BIN" --version`.
- **First-ever MCP setup stops with exit 3.** With no MCP servers configured at all,
  Claude 2.1.293's `mcp get` prints only
  ``No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.`` (exit 1,
  stderr only). The script only recognizes the `Configured servers:` form, so it fails
  closed with exit 3 and changes nothing. Check the answer yourself and, if it matches
  exactly, use the [manual fallback](#manual-fallback).
- **Name already exists (exit 2) or inconclusive (exit 3).** First make sure the code
  came from the script itself: its own exits happen **before** the `Command: …` line and
  carry its own message. A 1, 2 or 3 after `Command: …` with `--apply` comes from
  `claude mcp add` and may mean something was written; read Claude's message and check
  with `mcp get`. For the script's own exit 2/3, inspect the existing entry with
  `"$CLAUDE_BIN" mcp get codex-image-mcp` and note its scope and command. If it works,
  leave it alone. Replace it only **explicitly and on purpose**: remove that exact entry
  in its own scope, then register again.
- **`APPROVAL_REQUIRED`.** The task needed a permission that this bridge will not grant on
  your behalf, typically writing outside `cwd`, network access or a command escalation.
  If the task is appropriate, run it yourself in your own interactive Codex session.
  Don't try to get around the restriction with bypass flags or config overrides.
- **`POLICY_MISMATCH`.** Codex reported a thread policy different from the one requested
  (for example an extra writable folder or network access coming from your Codex
  config), so the job stopped **before** your prompt was sent to Codex. Check
  your Codex config for sandbox overrides.
- **`AUTH_REQUIRED`.** Run `codex login` in Terminal and sign in yourself, then try again.
  Never paste or copy tokens.
- **`MODEL_UNAVAILABLE`.** Codex did not advertise exactly one default model for your
  account. See [model selection](#tools) below.
- **The server doesn't appear in Claude Desktop.** Quit Desktop completely, reopen it, and
  start a fresh **Local** Code session. Running `/mcp` in the CLI first helps confirm the
  registration itself is fine.
- **`BUSY`, `TIMEOUT` or `OUTPUT_LIMIT`.** Only one job can run at a time; wait for it or
  cancel it. For time and size limits, see the [limits](#tools) below.
- **The image tool is missing.** `CODEX_IMAGE_OUTPUT_ROOT` was not set when you
  registered, or it was not an absolute, normalized path other than `/`.

## Uninstall

First run `"$CLAUDE_BIN" mcp get codex-image-mcp`. If it shows the **user**-scope
registration you created with this project, remove it with the official CLI you selected:

```sh
"$CLAUDE_BIN" mcp remove codex-image-mcp --scope user
```

If it shows a different scope, inspect it first. It might be shared or created by someone
else, so don't remove it blindly. Uninstalling does **not** delete your image output
folder, your Codex or Claude sign-ins, or the clone. Remove those yourself if you want to.

---

The sections below are the technical reference.

## Trust model — this is a capability, not a security boundary

- The delegated `prompt` runs as a **general Codex agent** using your normal Codex home,
  config, login, trust settings, plugins, hooks and MCP servers. Anything they can do under
  the native policy, a prompt can ask for. Plugins, hooks and MCP servers are trusted-local:
  the sandbox is **not** a containment boundary for them. Only send prompts you would type
  into Codex yourself.
- Every job uses a **new** app-server process and a **new** thread (no resume/fork of
  existing sessions), with the model `model/list` advertises as default (see
  [model selection](#tools)). `thread/start` sends `cwd`, `approvalPolicy: "on-request"`,
  `approvalsReviewer: "user"` and `sandbox: "workspace-write"`. `turn/start` then sends an
  explicit `sandboxPolicy` of
  `{type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true}`,
  so `cwd` is the only writable root, there is no network, and `/tmp` / `$TMPDIR` are
  not writable roots for the turn.
- **Policy check before the turn.** The effective policy that `thread/start` reports is
  verified first: `cwd`, `on-request`, reviewer `user`, `workspaceWrite`, network not
  enabled, and `writableRoots` either empty (cwd is the implicit root) or exactly `[cwd]`.
  Anything else, e.g. an extra root or network from your config, fails the job with
  `POLICY_MISMATCH` before `turn/start`. The thread-level `/tmp`/`$TMPDIR` flags cannot be
  set through `thread/start`; they are tolerated there and overridden by the explicit turn
  policy. (Observed with codex-cli 0.156.0: the thread reports `writableRoots: []`,
  `networkAccess: false` and both temp exclusions `false` before the turn override; see
  [`docs/workspace-write-verification.md`](docs/workspace-write-verification.md).)
- No bypass / dangerous flags and no `--config` overrides are used; this server never
  reads `auth.json`/`config.toml` and never logs in, extracts tokens, or falls back to an
  API key.
- **Native approvals are not bridged to an interactive UI.** Any approval request (command,
  file change, permissions), MCP elicitation, user-input request, dynamic tool call or auth
  refresh is **denied** with a JSON-RPC error (no fabricated answer), the turn is interrupted,
  the process terminated, and the job fails with a typed error such as `APPROVAL_REQUIRED`
  plus a coarse `request_kind` (never the raw request). Writes inside `cwd` need no approval;
  an attempted write outside it, network use or an escalation surfaces as such a request
  and is denied (headless: there is nobody to approve it).
- Plugins/MCP servers configured in Codex remain usable inside the native sandbox/approval
  policy; paid plugins may spend money — that is your responsibility.
- Task result text is Codex output and may contain sensitive material from your workspace.

## Tools

| tool | input | notes |
|---|---|---|
| `codex_status` | `{}` | CLI version, launch policy, installed plugin names (`plugin/installed`) and MCP server names (`mcpServerStatus/list` with `detail: "toolsAndAuthOnly"`, `limit: 50`, at most 4 pages / 100 names). Each listing has `truncated` (a local bound dropped entries) and `has_more` (peer still had a next page; `null` if unknown). A failed method gives `available:false` + a reason made only of fixed enums (e.g. `mcpServerStatus/list failed: rpc invalid_request/experimental_api_required`). No URLs/paths/accounts/tool schemas. |
| `codex_task_start` | `{prompt, cwd}` | `cwd`: absolute, normalized, existing directory, no symlinks, not `/`, `$HOME` or an ancestor of `$HOME`. It becomes the only writable root of the turn. Returns `job_id`. Single active job; `BUSY` otherwise. |
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
`NO_IMAGE_PRODUCED`, `IMAGE_VERIFICATION_FAILED`, `MODEL_UNAVAILABLE`, `POLICY_MISMATCH`.

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
processes running as your user; `cwd` is validated only at start. If the directory (or a
parent) is replaced, e.g. by a symlink, after validation, the writable root Codex applies
is whatever that path then resolves to.

## Prerequisites

- macOS, Node ≥ 22, official Codex CLI logged in normally (`codex login`) and the project
  directory trusted in your normal Codex config. The server uses `~/.local/bin/codex` unless
  `CODEX_BIN` is set to an absolute, normalized path (e.g. `/opt/homebrew/bin/codex`). An
  invalid `CODEX_BIN` fails closed; it never falls back to another location.

## Registering with Claude Code

`npm run register` prints the official command (dry run); `npm run register -- --apply` runs
`claude mcp add --transport stdio --scope user codex-image-mcp [-e CODEX_BIN=…] [-e CODEX_IMAGE_OUTPUT_ROOT=…] -- <abs node> <abs dist/src/server.js>`.
The name comes before any `-e`: `claude` 2.1.293 treats `-e` as variadic, so a name after
the last `-e` would be consumed as an env entry.
It never edits `~/.claude.json` directly and never overwrites: it first runs
`claude mcp get codex-image-mcp` and proceeds only on exit 1 with the exact not-found output
of `claude` 2.1.293 (`No MCP server named "codex-image-mcp". Configured servers: …`) on exactly
one stream (the CLI uses stderr; output on both streams is rejected). An
existing server of that name in any scope (exit 2) or any other output (exit 3) stops it.
This includes the empty-config answer of `claude` 2.1.293 (exit 1, stderr only:
``No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.``), which the
classifier intentionally does not accept: a first-ever MCP setup stops with exit 3 and
needs the [manual fallback](#manual-fallback). Exits 1/2/3 from the script itself occur
before the `Command:` line and write nothing; with `--apply`, the exit code of
`claude mcp add` is propagated unchanged (1 on timeout/signal) and carries no
"nothing changed" guarantee.
Export `CODEX_IMAGE_OUTPUT_ROOT=<absolute dir>` before running it to enable the image tool;
an invalid value fails closed.

## Setting up on another Mac

Each Mac uses its own local tools and its own login; nothing is copied between machines.
Follow [Before you start](#before-you-start) and [Install](#install) on that Mac.

## Status and evidence

- Fixture tests, lint, typecheck and build pass. Live runs (see
  [`docs/runtime-verification.md`](docs/runtime-verification.md)): `codex_status` and a
  `PONG` task succeeded under the earlier read-only policy. The current workspace-write
  policy was verified live through Claude Code (MCP tools only, no approvals): one job
  created a file inside `cwd` and a second, separate job modified it, with byte-exact
  read-back and an unchanged sentinel outside `cwd`
  ([`docs/workspace-write-verification.md`](docs/workspace-write-verification.md)).
  The single authorized image smoke (earlier read-only policy) generated exactly one
  native image but the MCP job **failed with `OUTPUT_LIMIT`**; the frame bound was then
  raised to 8 MiB and the image was recovered read-only via `thread/read` (hash-verified).
  The repaired image path has **not** been re-run live, so end-to-end image success is
  not demonstrated. Image editing is not offered.
- Protocol support was written against the installed `codex-cli 0.156.0` generated schema
  and source. The app-server protocol is evolving; other Codex versions may break this.
  The experimental API is **not** enabled (none of the methods used require it).
- Discovery from Claude Desktop's Local Code environment has not yet been independently
  verified.

## Development

```sh
npm install
npm run lint        # ESLint (typescript-eslint)
npm run typecheck
npm test            # build + node:test; fixtures only, never spawns Codex
npm run build
```

## Live smoke (parent-controlled, not part of `npm test`)

```sh
npm run build
node scripts/smoke.mjs status
node scripts/smoke.mjs task                               # "PONG" task, no file edits requested
node scripts/smoke.mjs write                              # create, then modify, one file in the workspace
node scripts/smoke.mjs image --confirm-spend-one-image    # ONE real generation, no retry
```

Each run uses a git-ignored `.smoke/<uuid>/` workspace and writes `evidence.json` there.
`write` checks exact UTF-8/LF bytes after each job, keeps the observed bytes as
`receipt-<step>.txt` and checks a sentinel outside the workspace. It drives the server
through the MCP SDK client; it is a supplement to, not a replacement for, the test
through Claude Code itself described above.

## License

MIT
