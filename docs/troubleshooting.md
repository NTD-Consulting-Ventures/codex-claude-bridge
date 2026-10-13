# Troubleshooting

- **`claude`/`codex` not found, wrong one used, or `SPAWN_FAILED`.** The register script
  searches as described in [setup step 2](setup.md#2-how-claude-and-codex-are-found) and
  prints what it found; set `CLAUDE_BIN` / `CODEX_BIN` to absolute paths to choose. At
  runtime the server uses only the stored `CODEX_BIN` (or `~/.local/bin/codex`). If an
  update moved the binary, `codex_status` shows `runtime.codex_launcher: "missing"`;
  replace the registration as in [Updating](setup.md#updating).
- **`env: node: No such file or directory`, or Codex unavailable with an npm install.**
  npm launchers need `node` on PATH. `codex_status` shows `runtime.node_dir_on_child_path`;
  if it is `false`, the registered Node has no sibling `node` (unusual layout). Register
  again from a Node installed in a standard layout.
- **Version compatibility.** See the [verification matrix](verification.md) for what was
  actually checked. Other versions may fail (e.g. `PROTOCOL_ERROR`), and an unknown
  `claude mcp get` "not found" text makes the register script stop with exit 3.
- **Sign-in.** `npm run register -- --check-auth` reports whether the exact `codex` and
  `claude` found are signed in and prints the official login command to run yourself.
- **Register script exit 2, 3 or 4.** Exit 2 names the existing ID (`codex-claude-bridge`
  or the earlier `codex-image-mcp`); inspect it with `claude mcp get <id>`. If it works,
  leave it alone. Replace it only on purpose, keeping its ID and every env entry (see
  [Updating](setup.md#updating)). Exit 3 prints a content-free
  summary of the probe (exit code, stream sizes, whether the named "not found" line was
  present); see the [manual fallback](setup.md#manual-fallback). Exit 4 means the
  registration was not confirmed; never assume it succeeded.
- **`OUTPUT_ROOT_INVALID`.** `CODEX_IMAGE_OUTPUT_ROOT` in the registration is empty or
  not an absolute, normalized path other than `/`. `codex_status` shows the reason under
  `image_output.error`. Fix the registration as in [Updating](setup.md#updating).
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
- **`AUTH_REQUIRED`.** Run `npm run register -- --check-auth` and the login command it
  prints yourself. Never paste or copy tokens.
- **`MODEL_UNAVAILABLE`.** Codex did not advertise exactly one default model. See
  [model selection](reference.md#model-selection).
- **Server missing in Claude Desktop.** Quit Desktop completely, reopen, and start a
  fresh **Local** Code session. Running `/mcp` in the CLI confirms the registration.
- **`BUSY`, `TIMEOUT`, `OUTPUT_LIMIT`.** One job at a time; wait or cancel. See the
  [limits](reference.md#tools).
