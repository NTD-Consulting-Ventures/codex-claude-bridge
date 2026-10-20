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
absolute path before registering to use another folder, and `CODEX_TASK_WALL_SECONDS`
(10–900) to change the default job limit of 300 s ([job timeout](docs/setup.md#job-timeout)). To list only the image tools,
see [image-only mode](docs/image-only.md) (opt-in; hides and refuses `codex_task_start`, not a sandbox).

Update in place: `git pull --ff-only && npm ci && npm run build` (no re-registration).
If a stored path changes, see [Updating](docs/setup.md#updating).

## Example

Start a new Claude Code session in a throwaway folder and ask:

> Call `codex_task_start` with `cwd` set to this folder's absolute path and the prompt
> `Create hello.txt containing hello, then draw a small red apple.` Then call
> `codex_task_wait` with the returned `job_id` until it is no longer `running`.

A successful result lists saved images in `files` (empty when Codex made none), e.g.
`/Users/you/codex-images/<uuid>/<uuid>.png`, with `width`, `height` and `index`. If the job
fails, times out or is cancelled, images that were already generated are still saved and
listed in `partial_files`. `codex_status` shows the Codex version and launcher, Node, the
launch policy, the limits, the last job and the image folder. This example is
documentation only; it was not run for this release.

For consistent characters across a series, put character sheets or an earlier version in
the folder and pass them as `reference_images` to `codex_image_generate`. See
[best practices for image series](docs/image-series.md).

## Limits

- Codex runs with `workspace-write`: it can write only inside `cwd`, with no network.
  Anything needing approval pauses the job until you approve or decline it in Claude Code
  (the default `ask` mode); `bypass` approves automatically and `deny` fails the job
  instead ([approvals](docs/approvals.md)).
- Codex still uses your normal config, plugins and MCP servers. This is a trusted-local
  convenience, not a security boundary.
- One running job at a time (`queue: true` queues up to 8), 300 s by default (`timeout_s`
  10–900 per job), no retries. The bridge is local, but turns and images are generated on
  OpenAI's servers, so a flaky connection shows up as timeouts. Image generation may use
  your plan allowance. Live image generation was not verified by the maintainers for this
  release (fixture tests, a schema check and a signed-out protocol check only).
- Tested combinations and pending checks: [docs/verification.md](docs/verification.md).

## More documentation

- [Setup details, discovery, updating, manual fallback and uninstall](docs/setup.md)
- [Image-only mode: setup, existing entries and limits](docs/image-only.md)
- [Approvals: ask in Claude Code, bypass or deny](docs/approvals.md)
- [Best practices for image series: references, timeouts, partial results](docs/image-series.md)
- [Image sessions: follow-up edits with an explicit `session_handle`](docs/image-sessions.md)
- [Security model, tools and protocol](docs/reference.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT
