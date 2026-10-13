# Troubleshooting

- **`claude`/`codex` not found, wrong one used, or `SPAWN_FAILED`.** Desktop and MCP
  servers don't use your shell's PATH, aliases or functions. Set absolute real paths as in
  [setup step 2](setup.md#2-pick-the-real-claude-and-codex-programs). Without `CODEX_BIN`
  the server only looks at `~/.local/bin/codex`. If an update moved the binary, replace
  your registration deliberately with the new path.
- **Version compatibility.** Tested with Codex CLI 0.156.0 and Claude Code 2.1.293. Other
  versions may fail (e.g. `PROTOCOL_ERROR`), and a changed `claude mcp get` "not found"
  text makes the register script stop with exit 3.
- **Register script exit 2 or 3.** Check that the code came from the script (before the
  `Command: …` line). Inspect the entry with `"$CLAUDE_BIN" mcp get codex-image-mcp`. If
  it works, leave it alone. Replace it only on purpose: remove that exact entry in its own
  scope, then register again. If the "not found" answer has extra warnings or other text,
  the script stops by design; see the [manual fallback](setup.md#manual-fallback).
- **`OUTPUT_ROOT_INVALID`.** `CODEX_IMAGE_OUTPUT_ROOT` in the registration is empty or
  not an absolute, normalized path other than `/`. `codex_status` shows the reason under
  `image_output.error`. Fix the registration (remove and register again).
- **`OUTPUT_ROOT_UNAVAILABLE`.** The image folder (or a parent) is a symlink, not a
  directory, not owned by you, or could not be created. Nothing was written. Use a real,
  owned folder.
- **`IMAGE_ITEM_INVALID` / `IMAGE_VERIFICATION_FAILED`.** Codex reported an image without
  a usable saved file, or the file did not verify as a PNG/JPEG under the Codex home. The
  job failed instead of returning partial results; any copied files were removed.
- **`APPROVAL_REQUIRED`.** The task needed a permission this bridge will not grant
  (writing outside `cwd`, network, escalation). Run it yourself in your own Codex
  session if appropriate. Don't work around it with bypass flags or config overrides.
- **`POLICY_MISMATCH`.** Codex reported a thread policy different from the requested one
  (e.g. an extra writable root or network from your Codex config). The prompt was not
  sent. Check your Codex config for sandbox overrides.
- **`AUTH_REQUIRED`.** Run `codex login` yourself. Never paste or copy tokens.
- **`MODEL_UNAVAILABLE`.** Codex did not advertise exactly one default model. See
  [model selection](reference.md#model-selection).
- **Server missing in Claude Desktop.** Quit Desktop completely, reopen, and start a
  fresh **Local** Code session. Running `/mcp` in the CLI confirms the registration.
- **`BUSY`, `TIMEOUT`, `OUTPUT_LIMIT`.** One job at a time; wait or cancel. See the
  [limits](reference.md#tools).
