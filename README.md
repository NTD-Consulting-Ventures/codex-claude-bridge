# codex-claude-bridge

A local MCP server that lets Claude Code hand tasks and image generation to the Codex CLI on your own Mac.

## Prerequisites

- macOS with Node.js 22 or newer and git.
- The official Codex CLI, signed in by you (`codex login`).
- Official Claude Code, signed in by you (`claude auth login`).

Each tool uses your own sign-in. Never copy tokens or config files between machines.

## Install

```sh
git clone https://github.com/NTD-Consulting-Ventures/codex-claude-bridge.git
cd codex-claude-bridge
npm ci
npm run build
codex login
claude auth login
npm run register              # dry run: prints the exact command, changes nothing
npm run register -- --apply   # registers the MCP server "codex-image-mcp" (user scope)
```

The script never overwrites an existing registration. It uses `claude` from your PATH
and `~/.local/bin/codex` unless you set `CLAUDE_BIN` / `CODEX_BIN` to absolute paths.
If it stops, see [setup details](docs/setup.md), including the manual fallback.

Images are saved to `~/codex-images` by default. Set `CODEX_IMAGE_OUTPUT_ROOT` to an
absolute path before registering to use another folder.

## Example

Start a new Claude Code session in a throwaway folder and ask:

> Call `codex_task_start` with `cwd` set to this folder's absolute path and the prompt
> `Create hello.txt containing hello, then draw a small red apple.` Poll
> `codex_task_status` with the returned `job_id` until it is no longer `running`.

A successful result looks like this:

```json
{ "text": "…", "text_truncated": false, "image_items": 1,
  "files": [{ "path": "/Users/you/codex-images/<uuid>/<uuid>.png",
              "mime_type": "image/png", "bytes": 123456, "sha256": "…" }] }
```

`files` is empty when Codex made no image. `codex_image_generate` takes the same
`{prompt, cwd}` and returns `{job_id, files, codex_version}`. `codex_status` shows the
Codex version, the launch policy and the image folder in use.

This example is documentation only. It was not run for this release.

## Limits

- Codex can write only inside `cwd`, with no network access. Anything that needs approval
  stops the job with `APPROVAL_REQUIRED`. Nothing is approved for you.
- Codex still runs with your normal config, plugins and MCP servers. This is a
  convenience, not a security boundary.
- One job at a time, 300 s by default. Failed jobs are not retried. Image generation may
  use up your plan allowance.
- Live image generation has not been verified for this release.
- Tested with Codex CLI 0.156.0 and Claude Code 2.1.293 only.

## More documentation

- [Setup details, manual fallback and uninstall](docs/setup.md)
- [Security model, tools and protocol](docs/reference.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Verification status and evidence](docs/verification.md)

## License

MIT
