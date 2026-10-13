# Verification status and evidence

## This release (0.2.0)

- Fixture tests, lint, typecheck and build are the automated checks (`npm test` never
  spawns Codex or Claude).
- **Live image generation has not been verified for this release.** No live image job,
  no live task and no live registration were run while implementing it. The default
  image folder, multi-image saving in `codex_task_start` and the empty-config install
  path are covered by fixture tests only.
- The empty-config `claude mcp get` answer that the register script now accepts was
  captured from the official Claude Code 2.1.293 CLI using an isolated
  `CLAUDE_CONFIG_DIR` with no credentials copied (exit 1, stdout empty, stderr exactly
  ``No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.``).

## Earlier releases (historical, unchanged)

These records describe earlier versions and policies. They are kept as written and are
**not** evidence of a successful live image generation through the MCP tool:

- [runtime-verification.md](runtime-verification.md) /
  [runtime-verification.json](runtime-verification.json): `codex_status` and a `PONG`
  task succeeded under the earlier read-only policy. The single authorized image smoke
  produced one native image, but the MCP job **failed with `OUTPUT_LIMIT`**; the image was
  later recovered read-only via `thread/read`. The repaired image path was not re-run.
- [workspace-write-verification.md](workspace-write-verification.md) /
  [workspace-write-verification.json](workspace-write-verification.json): through Claude
  Code, one job created a file inside `cwd` and a second job modified it, with byte-exact
  read-back and an unchanged sentinel outside `cwd`.
- [repair-verification.md](repair-verification.md),
  [safety-feasibility.md](safety-feasibility.md),
  [harness-evidence.json](harness-evidence.json).

## Development checks

```sh
npm ci
npm run lint
npm run typecheck
npm test        # build + node:test; fixtures only
npm run build
```

## Live smoke (manual, not part of `npm test`)

```sh
npm run build
node scripts/smoke.mjs status
node scripts/smoke.mjs task
node scripts/smoke.mjs write
node scripts/smoke.mjs image --confirm-spend-one-image   # ONE real generation, no retry
```

Each run uses a git-ignored `.smoke/<uuid>/` folder: `workspace/` is the task `cwd` and
`images/` is the image output root for every mode, so smoke runs never write to
`~/codex-images`. All modes require the five tools to be listed; `status` also requires
`image_generate_enabled: true` with `image_output` pointing at that run's `images/`.
Sanitized results go to `.smoke/<uuid>/evidence.json`. This SDK-client smoke supplements,
but does not replace, a test through Claude Code itself.
