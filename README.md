# codex-claude-bridge

A local MCP server that lets Claude Code hand tasks and image generation to the Codex CLI on your own Mac.

## Prerequisites

Install and sign in yourself; setup never installs, downloads or signs in for you.

- Node.js 22+ and git: <https://nodejs.org/en/download>
- Codex CLI: `npm install -g @openai/codex` (or `brew install --cask codex`), then `codex login`
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login`

Never copy tokens or config files between machines.

## Install

```sh
git clone https://github.com/NTD-Consulting-Ventures/codex-claude-bridge.git
cd codex-claude-bridge
npm ci
npm run build
npm run register                  # dry run: shows the claude/codex/node it found, changes nothing
npm run register -- --apply       # registers "codex-claude-bridge" (user scope) and verifies it
npm run register -- --check-auth  # optional: sign-in status of the exact claude/codex found
```

`--check-auth` only reports whether `codex login status` and `claude auth status` exit 0,
using the same absolute paths and Node `PATH` as the registration. If one is not signed
in, it prints the exact official login command to run yourself; registration works either way.

Your Terminal `PATH` is only used to *find* `claude` and `codex` (also `~/.local/bin`,
Homebrew, `npm prefix -g`). The registration stores absolute paths to Codex, Node and the
server, so Claude Desktop does not need your shell setup. Set `CLAUDE_BIN` / `CODEX_BIN`
to absolute paths to choose explicitly. If a registration named `codex-claude-bridge` or
the earlier `codex-image-mcp` already exists, the script stops (exit 2) and leaves it as
is; an existing `codex-image-mcp` keeps working. Afterwards start a new Claude Code
session (in Claude Desktop, a new Code session is enough).

Images are saved to `~/codex-images` by default. Set `CODEX_IMAGE_OUTPUT_ROOT` to an
absolute path before registering to use another folder. To list only the image tools,
see [image-only mode](docs/image-only.md) (opt-in; hides and refuses `codex_task_start`, not a sandbox).

Update in place: `git pull --ff-only && npm ci && npm run build` (no re-registration).
If a stored path changes, see [Updating](docs/setup.md#updating).

## Example

Start a new Claude Code session in a throwaway folder and ask:

> Call `codex_task_start` with `cwd` set to this folder's absolute path and the prompt
> `Create hello.txt containing hello, then draw a small red apple.` Poll
> `codex_task_status` with the returned `job_id` until it is no longer `running`.

A successful result lists saved images in `files` (empty when Codex made none), e.g.
`/Users/you/codex-images/<uuid>/<uuid>.png`. `codex_status` shows the Codex version and
launcher, Node, the launch policy and the image folder. This example is documentation
only; it was not run for this release.

## Limits

- Codex runs with `workspace-write`: it can write only inside `cwd`, with no network.
  Anything needing approval stops the job with `APPROVAL_REQUIRED`; nothing is approved for you.
- Codex still uses your normal config, plugins and MCP servers. This is a trusted-local
  convenience, not a security boundary.
- One job at a time, 300 s by default, no retries. Image generation may use your plan
  allowance; live image generation has not been verified for this release.
- Tested combinations and pending checks: [docs/verification.md](docs/verification.md).

## More documentation

- [Setup details, discovery, updating, manual fallback and uninstall](docs/setup.md)
- [Image-only mode: setup, existing entries and limits](docs/image-only.md)
- [Security model, tools and protocol](docs/reference.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT
