# Setup details

This page expands the short install in the [README](../README.md).

## Prerequisites

- **macOS** with Terminal access. Everything runs locally.
- **Node.js 22 or newer** (<https://nodejs.org/en/download>; check with `node --version`).
- **The official Codex CLI** (<https://github.com/openai/codex#quickstart>, e.g.
  `npm install -g @openai/codex`). Sign in yourself with `codex login`, and trust the
  folders you plan to delegate work in through your normal Codex settings.
- **Official Claude Code** (<https://code.claude.com/docs/en/setup>). Sign in yourself with
  `claude auth login` and check with `claude auth status`.
- **git**.

Never copy authentication tokens, `auth.json`, `config.toml`, `~/.claude.json` or other
credential or config files from another Mac or another person. This project never reads
those files, never signs in for you, and never falls back to an API key.

Tested with Codex CLI **0.156.0** and Claude Code **2.1.293**.

## 1. Clone and build

```sh
git clone https://github.com/NTD-Consulting-Ventures/codex-claude-bridge.git
cd codex-claude-bridge
npm ci
npm run build
```

Keep the clone in a permanent place. Claude records the **absolute path** to the built
server, so moving or deleting the folder breaks the registration. If you move it,
register again.

## 2. Pick the real `claude` and `codex` programs

Claude Desktop and MCP servers don't load your shell setup, so aliases, functions and
PATH changes from `~/.zshrc` may be missing. Use absolute, normalized paths to the real
executables:

```sh
type -a claude; type -a codex
export CLAUDE_BIN="$(P="$(command -v claude)" node -e 'process.stdout.write(require("node:fs").realpathSync(process.env.P))')"
export CODEX_BIN="$(P="$(command -v codex)" node -e 'process.stdout.write(require("node:fs").realpathSync(process.env.P))')"
"$CLAUDE_BIN" --version; "$CODEX_BIN" --version; "$CLAUDE_BIN" auth status
```

- `CODEX_BIN` is stored in the registration. Without it the server uses exactly
  `~/.local/bin/codex`.
- `CLAUDE_BIN` selects the `claude` the setup script runs. Without it, the first `claude`
  on PATH is used.
- If either is set but not an absolute, normalized path, setup stops. It never falls back.

## 3. Image output folder

Native images Codex generates are copied to `~/codex-images` by default. To use another
folder, export `CODEX_IMAGE_OUTPUT_ROOT` before registering. It must be an absolute,
normalized path other than `/` (no `..`, no `//`, no trailing `/`). An empty or otherwise
invalid value stops setup; it never falls back to the default.

The register script resolves the folder with the same code the server uses and always
stores the result in the registration as `-e CODEX_IMAGE_OUTPUT_ROOT=<path>`. The folder
is created (mode 0700) on the first image save. It must not be, or sit below, a symlink
and must be owned by you; otherwise the job fails with `OUTPUT_ROOT_UNAVAILABLE` and
nothing is written. The folder is written by this server only; it is never added to
Codex's writable roots.

## 4. Preview and register

```sh
npm run register              # dry run
npm run register -- --apply   # register
```

The script first runs `claude mcp get codex-image-mcp` and continues only when Claude
answers "not found" in exactly one of these two verified forms (exit 1, stdout empty):

- **No MCP servers configured at all** (verified with Claude 2.1.293 in an isolated config
  directory), stderr exactly:
  ``No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.``
- **Other servers configured:** stderr starts with
  `No MCP server named "codex-image-mcp". Configured servers:` and the list does not
  contain `codex-image-mcp`.

Anything else (warnings, output on both streams, other wording) is treated as
inconclusive. The registered MCP name stays `codex-image-mcp` so existing setups keep
working. The command it runs is:

```text
claude mcp add --transport stdio --scope user codex-image-mcp [-e CODEX_BIN=…] -e CODEX_IMAGE_OUTPUT_ROOT=… -- <abs node> <abs dist/src/server.js>
```

The name must come **before** any `-e`: Claude 2.1.293 reads `-e` as taking several
values, so a name after it would be read as another env entry.

| script exit | meaning |
|---|---|
| 0 | registered (or, without `--apply`, the dry run passed) |
| 1 | not built, an invalid `CLAUDE_BIN` / `CODEX_BIN` / `CODEX_IMAGE_OUTPUT_ROOT`, or `claude` not found |
| 2 | a server named `codex-image-mcp` already exists in some scope; nothing changed |
| 3 | inconclusive whether the name is free; nothing changed |

Exits 1, 2 and 3 from the script happen before it prints the `Command: …` line. With
`--apply`, after that line the script returns whatever `claude mcp add` returned (1 on
timeout); that code carries no "nothing changed" guarantee, so check with
`"$CLAUDE_BIN" mcp get codex-image-mcp` before trying again. Don't remove an existing
registration just so the script can continue.

### Manual fallback

Use this only if the script can't be used. Check that the name is free, and read the exit
code immediately after each command:

```sh
"$CLAUDE_BIN" mcp get codex-image-mcp; echo $?
"$CLAUDE_BIN" mcp get codex-image-mcp 2>/dev/null; echo $?
```

Continue only if both print exit `1`, the second prints nothing else, and the first
prints exactly one of the two "not found" forms above with nothing mixed in. On a
first-ever MCP setup (no servers configured at all) that is this single line:

```text
No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.
```

Then, from the clone:

```sh
NODE_BIN="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.execPath))')"
REPO_DIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.cwd()))')"
"$CLAUDE_BIN" mcp add --transport stdio --scope user codex-image-mcp \
  -e "CODEX_BIN=$CODEX_BIN" \
  -e "CODEX_IMAGE_OUTPUT_ROOT=$HOME/codex-images" \
  -- "$NODE_BIN" "$REPO_DIR/dist/src/server.js"
```

Use your own absolute image folder in place of `$HOME/codex-images` if you chose one.
If `mcp add` reports an error, check with `mcp get` before trying again.

## Check that it works

Start a **new** Claude Code session, run `/mcp` and confirm `codex-image-mcp` is listed
with five tools. Ask Claude to call `codex_status`; it should show your Codex version,
`image_generate_enabled: true` and `image_output` with the folder in use. For a first
write test, use an empty throwaway folder (never your home folder) as `cwd`. Each job is
a new Codex thread.

Claude Desktop: quit it completely, reopen it, and start a fresh **Local** Code session.
Remote/cloud sessions cannot reach your Mac. Discovery in Desktop Local has not been
independently verified.

## Another Mac

Each Mac uses its own tools and its own sign-ins. Repeat these steps there.

## Uninstall

Run `"$CLAUDE_BIN" mcp get codex-image-mcp`. If it shows the user-scope entry you created:

```sh
"$CLAUDE_BIN" mcp remove codex-image-mcp --scope user
```

If it shows another scope, inspect it first. Uninstalling does not delete your image
folder, your sign-ins or the clone.

## Package names

The package is `codex-claude-bridge` (version 0.2.0, not published to npm). Both bin
names, `codex-claude-bridge` and the older `codex-image-mcp`, start the same server.
The MCP server ID and protocol name remain `codex-image-mcp`.
