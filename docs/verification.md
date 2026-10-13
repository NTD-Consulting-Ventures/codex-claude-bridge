# Verification status and evidence

## This release (0.2.1, portable installer)

- Automated checks on the final tree: all 214 fixture tests, lint, typecheck, build and
  `git diff --check` pass. Installer tests run `scripts/register.mjs` end to end against
  a **fake** `claude` CLI and fake `codex`/`npm` launchers in temporary directories
  (minimal PATH without `node`, paths with spaces, symlinked npm-style launchers); they
  never spawn the real Codex or Claude.
- Maintainer checks on the **final** implementation, with official CLIs, an isolated
  `CLAUDE_CONFIG_DIR` per run, `PATH=/usr/bin:/bin`, no credentials copied, no direct
  reads of Claude config files and no global config mutation. Codex 0.156.0 is the
  native install; Codex 0.162.1 is the official npm package (Node launcher). Summary in
  [`portable-install-verification.json`](portable-install-verification.json):

| Check (final implementation) | Claude Code | Codex CLI | Result |
|---|---|---|---|
| register `--apply` as `codex-claude-bridge`, readback, collision (exit 2, nothing changed) | 2.1.293 | 0.156.0 native | passed |
| same | 2.1.293 | 0.162.1 npm | passed |
| same, with 19 sentinel registrations (truncated `mcp get` recognized; first/last sentinel unchanged) | 2.1.295 | 0.156.0 native | passed |
| same, with 19 sentinel registrations | 2.1.295 | 0.162.1 npm | passed |
| existing legacy `codex-image-mcp` kept with its custom `SENTINEL_OVERRIDE`; no canonical duplicate | 2.1.293 | — | passed |
| same | 2.1.295 | — | passed |
| `codex_status` via MCP SDK smoke client, all five tools listed | — | 0.156.0 native | passed |
| same | — | 0.162.1 npm | passed |
| owned write smoke: create + modify byte-exact, outside sentinel unchanged | — | 0.156.0 native | passed |
| same | — | 0.162.1 npm | passed |

- The runtime smokes used an MCP SDK client started by the maintainer, not a new paid
  Claude-driven harness run. The app-server `initialize` request sends
  `experimentalApi: false`; upstream still labels the app-server itself experimental.
- Not covered: image generation or plugins, a live `--check-auth` run (fixture tests
  only until a no-identity live check is done), and any remote machine. These results
  show the tested local versions work; they do not promise compatibility with future
  CLI versions, which is detected from the CLIs' output formats.
- Raw receipts stay in the git-ignored `.harness-evidence/` and `.smoke/` folders and
  are not shipped; the JSON summary lists their relative paths only.

Historic observation (pre-correction candidate, superseded by the matrix above): that
candidate still registered under the ID `codex-image-mcp`. Its checks with Claude Code
2.1.293 and Codex 0.156.0 / 0.162.1 (register, collision, `codex_status`, and a 0.162.1
write smoke) passed, but `--apply` with 19 configured servers on Claude Code 2.1.295
**failed closed (exit 3)**: `mcp get` listed 8 names followed by
``(and 11 more — run `claude mcp list` to see all)``, a suffix that candidate did not
understand, so nothing was registered. The final parser accepts exactly that suffix.

Historic records and tracked evidence were edited only to replace a personal home
directory with the neutral placeholder `/Users/example-user` (labeled
`path_substitution_note` where it occurs); the observations are otherwise unchanged.

## Release 0.2.0 (historical)

- Fixture tests, lint, typecheck and build are the automated checks (`npm test` never
  spawns Codex or Claude).
- **Live image generation has not been verified for this release.** No live image job,
  no live task and no live registration were run while implementing it. The default
  image folder, multi-image saving in `codex_task_start` and the empty-config install
  path are covered by fixture tests only.
- The empty-config `claude mcp get` answer that the register script now accepts was
  captured from the official Claude Code 2.1.293 CLI using an isolated
  `CLAUDE_CONFIG_DIR` with no credentials copied (exit 1, stdout empty, stderr exactly
  ``No MCP server named "codex-image-mcp". Run `claude mcp add` to add one.``; that
  release registered the ID `codex-image-mcp`).

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
