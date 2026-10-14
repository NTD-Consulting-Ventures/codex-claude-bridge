# Setup details

This page expands the short install in the [README](../README.md).

## Prerequisites

- **macOS** with Terminal access. Everything runs locally.
- **Node.js 22 or newer** (<https://nodejs.org/en/download>; check with `node --version`).
- **The official Codex CLI** (<https://github.com/openai/codex>): `npm install -g @openai/codex`
  or `brew install --cask codex`. Sign in yourself with `codex login`, and trust the
  folders you plan to delegate work in through your normal Codex settings.
- **Official Claude Code** (<https://docs.anthropic.com/en/docs/claude-code/setup>):
  `curl -fsSL https://claude.ai/install.sh | bash` or `npm install -g @anthropic-ai/claude-code`.
  Sign in yourself with `claude auth login` and check with `claude auth status`.
- **git**.

The register script never installs, downloads or signs in to anything; when something is
missing it stops and prints the commands above.

Never copy authentication tokens, `auth.json`, `config.toml`, `~/.claude.json` or other
credential or config files from another Mac or another person. This project never reads
those files, never signs in for you, and never falls back to an API key.

## 1. Clone and build

```sh
git clone https://github.com/NTD-Consulting-Ventures/codex-claude-bridge.git
cd codex-claude-bridge
npm ci
npm run build
```

Keep the clone in a permanent place. Claude records the **absolute path** to the built
server, so moving or deleting the folder breaks the registration (see "Updating").

## 2. How `claude` and `codex` are found

Claude Desktop and MCP servers don't load your shell setup, so aliases, functions and
PATH changes from `~/.zshrc` are missing there. The register script therefore finds each
program once, in your Terminal, and **stores absolute paths** in the registration:

1. `CLAUDE_BIN` / `CODEX_BIN` if set. It must be an absolute, normalized path to an
   executable file (spaces and symlinks are fine). Empty, relative, missing or
   non-executable values stop setup; there is no fallback.
2. Absolute directories on your `PATH`, in order (empty and relative entries ignored).
3. `~/.local/bin`, `/opt/homebrew/bin` (macOS), `/usr/local/bin`.
4. `<npm prefix -g>/bin`, using an `npm` found the same way or next to the current Node.
   The call is bounded and its output must be one absolute path.

It then runs `--version` on both (bounded, output checked) and stops if that fails.
Registered: `CODEX_BIN=<absolute codex>`, `CODEX_IMAGE_OUTPUT_ROOT=<absolute folder>`,
the absolute current Node (`process.execPath`) and the absolute `dist/src/server.js`.

npm installs of Codex and Claude are small Node scripts (`#!/usr/bin/env node`) behind a
symlink, so they need `node` on `PATH`. Every Codex, Claude and npm process started by
this project (setup, `--version`, `codex_status`, app-server) gets the directory of the
current Node put first on its `PATH`, only if that directory's `node` is the same
binary. Nothing else in the environment changes, and the programs are always started
directly (no shell, no Node wrapper). Native binaries are unaffected.

At runtime the server does no PATH or npm discovery: it uses the stored `CODEX_BIN`, or
`~/.local/bin/codex` when unset. An empty or invalid `CODEX_BIN` fails closed.

## 3. Image output folder

Native images Codex generates are copied to `~/codex-images` by default. To use another
folder, export `CODEX_IMAGE_OUTPUT_ROOT` before registering. It must be an absolute,
normalized path other than `/` (no `..`, no `//`, no trailing `/`). An empty or otherwise
invalid value stops setup; it never falls back to the default.

The register script resolves the folder with the same code the server uses and always
stores the result in the registration. The folder is created (mode 0700) on the first
image save. It must not be, or sit below, a symlink and must be owned by you; otherwise
the job fails with `OUTPUT_ROOT_UNAVAILABLE` and nothing is written. The folder is
written by this server only; it is never added to Codex's writable roots.

## 4. Preview and register

```sh
npm run register              # dry run: prints what was found and the exact command
npm run register -- --apply   # register, then verify via readback
```

New registrations use the server ID `codex-claude-bridge`. Earlier releases registered
`codex-image-mcp`; such an entry is detected and left exactly as it is (no migration).
Before any change the script runs `claude mcp get <id>` for **both** IDs and continues
only when, for each, Claude answers with exit 1, empty stdout and exactly one stderr line
that is either

- ``No MCP server named "<id>". Run `claude mcp add` to add one.`` (no MCP servers at
  all; observed with Claude 2.1.293 and 2.1.295), or
- `No MCP server named "<id>". Configured servers: ` followed by a list of distinct,
  well-formed names: plain ids (`alpha`, `beta-tools`), `claude.ai <Connector>` names and
  `plugin:<plugin>:<server>`, optionally followed by the truncation suffix
  ``(and N more — run `claude mcp list` to see all)`` (observed with Claude 2.1.295 for
  19 servers: 8 names listed, then `(and 11 more …)`).

The named "No MCP server named "<id>"" diagnostic is what proves the ID is free; the list
is only checked to be well formed and never to contain that ID. Warnings, other streams,
unknown wording or names, timeouts and signals are inconclusive. If either ID exists the
script stops with exit 2; if either answer is inconclusive it stops with exit 3 (a
content-free summary is printed). Nothing is added in either case. There is no
structured output option for `mcp get`.

With `--apply` it runs:

```text
claude mcp add --transport stdio --scope user codex-claude-bridge -e CODEX_BIN=… -e CODEX_IMAGE_OUTPUT_ROOT=… -- <abs node> <abs dist/src/server.js>
```

The name comes **before** any `-e` (Claude reads `-e` as taking several values). Then
it reads the entry back with `claude mcp get` and requires user scope, `Type: stdio`, the
exact command, the exact single argument and exactly those two env entries. With
`CODEX_BRIDGE_MODE=general|image-only` set, a third entry `-e CODEX_BRIDGE_MODE=<mode>`
is added and read back too; see [image-only.md](image-only.md).

| script exit | meaning |
|---|---|
| 0 | registered and verified (or, without `--apply`, the dry run passed) |
| 1 | not built, bad arguments, an invalid `CLAUDE_BIN` / `CODEX_BIN` / `CODEX_IMAGE_OUTPUT_ROOT` / `CODEX_BRIDGE_MODE`, or a CLI not found / failing `--version` |
| 2 | a server named `codex-claude-bridge` or `codex-image-mcp` already exists in some scope; nothing changed |
| 3 | inconclusive whether both IDs are free; nothing changed |
| 4 | `mcp add` failed or the readback did not match; **not** confirmed. Inspect with `mcp get` before anything else |
| 5 | only with `--check-auth`: a sign-in was not confirmed; nothing changed |

The script never removes or renames an entry, including after exit 4.

### Sign-in check (optional)

`npm run register -- --check-auth` registers nothing. It runs `<codex> login status` and
`<claude> auth status` with the absolute paths it found and the same Node `PATH` prefix
the registration uses, and reports only whether each exited 0 (their output, which can
name your account, is not shown). For one that is not signed in it prints the official
login command with those exact paths, e.g. `PATH='/opt/homebrew/bin':"$PATH" '/opt/homebrew/bin/codex' login`;
run it yourself. Registration does not require sign-in. `CODEX_BRIDGE_MODE` is validated
here too: an invalid value stops it with exit 1 before any CLI is found or run; a valid
one has no effect on the check.

### Manual fallback

Use this only if the script can't be used (for example exit 3 on an unexpected Claude
wording). Check that **both** IDs are free, reading the exit code right after each:

```sh
claude mcp get codex-claude-bridge; echo $?
claude mcp get codex-image-mcp; echo $?
```

Stop if either exits `0` (it is already registered). Continue only if both print exit `1`
and their `No MCP server named "<id>".` line. Then, from the clone, with `CODEX_BIN` set
to the absolute path the dry run printed:

```sh
claude mcp add --transport stdio --scope user codex-claude-bridge \
  -e "CODEX_BIN=$CODEX_BIN" \
  -e "CODEX_IMAGE_OUTPUT_ROOT=$HOME/codex-images" \
  -- "$(node -p process.execPath)" "$PWD/dist/src/server.js"
claude mcp get codex-claude-bridge
```

## Check that it works

Start a **new** Claude Code session (in Claude Desktop, a new Local Code session is
enough; no need to quit the app), run `/mcp` and confirm `codex-claude-bridge` (or, for
an older registration, `codex-image-mcp`) is listed with five tools (four in
[image-only mode](image-only.md)). Ask Claude to call
`codex_status`; `runtime` shows the Codex path and launcher kind (`native` or `node_shebang`), the Node path and version, and whether the
Node directory is put on the children's `PATH`; `image_output` shows the folder in use.
For a first write test, use an empty throwaway folder (never your home folder) as `cwd`.
Remote/cloud sessions cannot reach your Mac.

## Updating

Same clone, same path, no re-registration:

```sh
cd /path/to/codex-claude-bridge
git pull --ff-only && npm ci && npm run build
```

This works for both server IDs; an existing `codex-image-mcp` registration needs no
change. Do not make a second clone or a second registration.

If a stored path itself changes (clone moved, Node or Codex reinstalled elsewhere;
`codex_status` then reports Codex `missing` or the server stops starting), you can
replace **your own** entry by hand. This is opt-in; the register script never does it
(it stops with exit 2 while either ID exists), and it is not a migration: keep the ID
you already have. Below, `ID` is that existing ID (`codex-claude-bridge` or
`codex-image-mcp`).

1. Inspect it: `claude mcp get ID`. Continue only if it shows `Scope: User config`,
   `Type: stdio`, a `Command` that is a Node binary and an `Args` line that is this
   clone's `dist/src/server.js` (old location if the clone moved). Anything else is not
   an entry this project created: stop and leave it alone.
2. Write down **every** `Environment` line exactly (`CODEX_BIN`,
   `CODEX_IMAGE_OUTPUT_ROOT` and any other key you added), plus `Command` and `Args`.
3. Remove only that entry: `claude mcp remove ID --scope user`. Other servers are not
   affected.
4. Re-add it under the **same ID** with **every** recorded env entry, changing only the
   path that moved (the register script cannot do this: it always stores just
   `CODEX_BIN` and `CODEX_IMAGE_OUTPUT_ROOT`, and exported shell variables are not
   forwarded into the registration). The name goes before the first `-e`:

   ```sh
   claude mcp add --transport stdio --scope user ID \
     -e "CODEX_BIN=<recorded or new absolute codex>" \
     -e "CODEX_IMAGE_OUTPUT_ROOT=<recorded folder>" \
     -e "<OTHER_KEY>=<recorded value>" \
     -- "<recorded or new absolute node>" "<absolute clone>/dist/src/server.js"
   ```

5. `claude mcp get ID` and compare it line by line with step 2.

## Another Mac

Each Mac uses its own tools and its own sign-ins. Repeat these steps there.

## Uninstall

Run `claude mcp get codex-claude-bridge` (or `claude mcp get codex-image-mcp` for an
older registration). If it shows the user-scope entry you created:

```sh
claude mcp remove codex-claude-bridge --scope user   # or: codex-image-mcp
```

If it shows another scope, inspect it first. Uninstalling does not delete your image
folder, your sign-ins or the clone.

## Package names

The package is `codex-claude-bridge` (version 0.2.3, not published to npm). The MCP
protocol name is `codex-claude-bridge` and new registrations use that server ID; older
registrations named `codex-image-mcp` keep working unchanged. Both bin names,
`codex-claude-bridge` and the legacy alias `codex-image-mcp`, start the same server. The
tool names (`codex_status`, `codex_task_start`, …) are unchanged.
