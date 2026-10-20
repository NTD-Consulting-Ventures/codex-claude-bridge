# Image-only mode (opt-in)

By default the bridge lists seven tools. With `CODEX_BRIDGE_MODE=image-only` in the
environment the server is started with (preferably stored in its registration; see
[Where the mode comes from](#where-the-mode-comes-from)) it lists only these six,
unchanged:

- `codex_status`
- `codex_image_generate`
- `codex_task_status`
- `codex_task_wait`
- `codex_task_approve`
- `codex_task_cancel`

Use it when you want Claude to see only image generation and not general task delegation.

## What it is, and what it is not

**It narrows the MCP tool list. It is not a sandbox and not a security boundary.**

- `codex_image_generate` still runs a normal Codex agent turn: your signed-in native
  Codex, its default model, your Codex config, trust settings, plugins, hooks and MCP
  servers. Image-only mode removes no Codex capability and changes no model, API key or
  login handling.
- The launch policy is the same as in general mode: `workspace-write` with `cwd` as the
  only writable root, no sandbox network, `/tmp` and `$TMPDIR` excluded, `on-request`
  approvals. Elevated approval requests follow the [approval mode](approvals.md), exactly
  as in general mode. See [reference.md](reference.md).
- The bridge wraps the description in an instruction to generate exactly one image and
  not to run shell commands, edit files or call other tools. Codex is **asked**, not
  forced. A malicious or careless description can still make Codex run shell commands,
  write inside `cwd`, or use plugins, MCP servers and network access that your native
  Codex config and policy allow (plugins, hooks and MCP servers are not contained by the
  sandbox). Only send descriptions you would type into Codex yourself.

## What changes in image-only mode

| | general (default) | image-only |
|---|---|---|
| tools listed | all seven | the six above |
| direct `codex_task_start` call | runs | `TOOL_DISABLED`, before any argument, `cwd` or output-folder check; no job, no Codex process |
| unknown tool name | `UNKNOWN_TOOL` | `UNKNOWN_TOOL` |
| `codex_task_status` / `codex_task_wait` / `codex_task_approve` / `codex_task_cancel` | any job | image jobs only; other job IDs are `UNKNOWN_JOB` |
| `codex_status` | `bridge_mode: "general"` | `bridge_mode: "image-only"` |

Image saving (including `partial_files`), the output folder, reference images, timeouts,
the queue, cancel and `BUSY` work exactly as in general mode. Without `codex_task_start`,
the reference-image fallback for an older Codex (asking Codex to open the files itself) is
not available; use a Codex whose schema lists `localImage` input.

The mode is read once when the server starts and stays fixed until it exits. There is no
per-call option. Unset means `general`. Any other value, including an empty or
whitespace-only one or different capitalization, stops the server before it accepts any
request: it writes a fixed message naming `CODEX_BRIDGE_MODE` to stderr (never the value
itself) and exits with status 2, so the server is not available in Claude.

## Where the mode comes from

The server is started by Claude Code and inherits the environment Claude Code itself was
launched with; the registration's stored `env` is applied on top. Observed with the
official Claude Code CLI 2.1.293:

- **Stored in the registration** (`CODEX_BRIDGE_MODE=general` or `image-only` in the
  entry's `env`): that value is used, whatever the surrounding environment says.
- **Not stored:** the server gets whatever `CODEX_BRIDGE_MODE` Claude Code inherited. If
  you `export CODEX_BRIDGE_MODE=...` in a Terminal and start `claude` from that shell, the
  server runs in that mode (and an invalid value stops it).
- **Neither:** `general`.

Exporting the variable never rewrites the stored registration; `claude mcp get` shows
only what is stored. If you rely on the default, make sure no `CODEX_BRIDGE_MODE` is set
in the environment you start Claude Code from (`unset CODEX_BRIDGE_MODE`, and check your
shell profile). For a persistent opt-in, store the mode in the registration deliberately
rather than depending on the launch environment.

## Fresh setup

From the clone, after `npm ci && npm run build`, with no registration named
`codex-claude-bridge` or `codex-image-mcp` yet:

```sh
CODEX_BRIDGE_MODE=image-only npm run register              # dry run: shows the mode and the exact command, changes nothing
CODEX_BRIDGE_MODE=image-only npm run register -- --apply   # registers, then verifies the readback
```

The script validates the value first (exactly `general` or `image-only`); anything else
stops it with exit 1 before it finds or runs `claude`. It adds
`-e CODEX_BRIDGE_MODE=image-only` next to the usual `CODEX_BIN` and
`CODEX_IMAGE_OUTPUT_ROOT`, and `claude mcp get` must read all three back exactly.
Without `CODEX_BRIDGE_MODE` the script registers exactly what 0.2.1 did (no mode stored,
so the server runs in general mode unless Claude Code is launched with
`CODEX_BRIDGE_MODE` in its environment; see
[Where the mode comes from](#where-the-mode-comes-from)). `--check-auth` validates the mode the same way (an
invalid value exits 1 before any CLI is found or run); a valid mode does not affect the
sign-in check, and `--check-auth` never changes MCP config.

Start a new Claude Code session and ask Claude to call `codex_status`; it should report
`"bridge_mode": "image-only"`, and `/mcp` should show six tools.

## Opting an existing registration in

There is no automatic migration. The register script never changes an existing entry;
it stops with exit 2. The official CLI has no in-place update either: `claude mcp
add-json` for an ID that already exists in that scope fails (exit 1, e.g. `MCP server
codex-claude-bridge already exists in user config`). Switching an existing entry therefore means replacing
it: a scoped `claude mcp remove` followed by a scoped `claude mcp add-json` under the
**same ID and scope**. Do this only deliberately, by hand, after the preparation below.
Never remove first and work out the configuration afterwards. If any value, the scope or
the args are uncertain at any step before the removal, stop there: nothing has changed.

1. **Inspect.** `claude mcp get ID`, where `ID` is the name you registered
   (`codex-claude-bridge` or the earlier `codex-image-mcp`). Continue only if it shows
   `Type: stdio`, a `Command` that is a Node binary and an `Args` line that is exactly
   one argument: the absolute path to this clone's `dist/src/server.js`. Otherwise stop:
   it is not an entry this procedure covers. In particular, stop if `Args` shows any
   extra argument, or if the line contains spaces and you cannot tell for certain whether
   it is one path or several arguments (`claude mcp get` prints them space-separated). Do
   not guess how to split it.
2. **Record the complete original.** Save the exact ID, the `Scope` (`User config` →
   `user`, `Local config` → `local`, `Project config` → `project`), `Command`, **all**
   `Args` and **every** `Environment` line (`CODEX_BIN`, `CODEX_IMAGE_OUTPUT_ROOT`,
   `CODEX_BRIDGE_MODE` if present, and any other key) in a file you keep.
3. **Write the restore command** from that record, changing nothing:

   ```sh
   claude mcp add-json --scope <scope> ID '{"type":"stdio","command":"<Command>","args":["<Args>"],"env":{"CODEX_BIN":"<value>","CODEX_IMAGE_OUTPUT_ROOT":"<value>","<OTHER_KEY>":"<value>"}}'
   ```

   This is a template, not a command to run: replace every `<...>` placeholder and `ID`
   with the recorded values, and drop the `<OTHER_KEY>` entry if there is none. `args`
   holds exactly one element, the single `server.js` path from step 1. Never run a
   command that still contains a placeholder.

   Escape `"` and `\` inside JSON values; a value containing `'` needs shell quoting.
   Check the JSON (for example with `jq .` on the quoted payload) and compare every key
   and value with step 2. If you cannot account for a value exactly, stop.
4. **Write the replacement command:** a copy of the restore command whose only change
   is `"CODEX_BRIDGE_MODE":"image-only"` in `env` (added, or replacing an existing
   value). Same ID, scope, command, args and every other env entry. Check it the same
   way.
5. **Note your other MCP servers** (`claude mcp list`) so you can confirm afterwards
   that they were not affected.
6. **Only now, and only if you explicitly decide to go ahead:** remove the entry in
   its recorded scope, `claude mcp remove --scope <scope> ID`, then run the replacement
   command from step 4.
7. **Read back.** `claude mcp get ID` must show the same scope, `Command`, `Args` and
   environment lines as step 2, plus `CODEX_BRIDGE_MODE=image-only`, and `claude mcp
   list` must still show every other server from step 5 unchanged.
8. **If something went wrong, recover.** The original entry is **gone** (it was removed
   in step 6). Do not retry variations of the replacement; find out what went wrong
   first. Only ever touch the exact ID in the recorded scope; never remove an entry with
   that ID in another scope, or any other server.
   - **The add command failed.** It may still have left an entry behind, so inspect
     first: `claude mcp get ID`.
     - If no entry with that ID exists in the recorded scope, run the saved restore
       command from step 3.
     - If an entry exists in the **same recorded scope**, look at what it contains,
       then remove exactly that entry, `claude mcp remove --scope <scope> ID`, and run
       the saved restore command from step 3.
   - **The add succeeded but the readback differs.** The new entry exists, so the
     restore command alone would fail with "already exists". Remove that new entry in
     the recorded scope, `claude mcp remove --scope <scope> ID`, then run the saved
     restore command from step 3.

   Then read back with `claude mcp get ID` and compare against step 2 (the complete
   original, with nothing added). The restore can fail too: if the remove or the restore
   command fails, or the readback still differs, stop. Do not improvise further; recover
   by hand from the record you saved in step 2.

To go back to general mode, follow the same steps with `CODEX_BRIDGE_MODE` left out of
the replacement (or set to `general`). Leaving it out means the server uses whatever
`CODEX_BRIDGE_MODE` Claude Code inherits, so also clear any exported value from the
environment you start Claude Code from; storing `general` explicitly overrides it. Then
start a new Claude Code session.
