# Runtime verification (sanitized)

Machine-readable form: [`runtime-verification.json`](runtime-verification.json). Evidence
files live under the git-ignored `.smoke/`. No image bytes, base64, config, account or
credential data is recorded here. Versions: `codex-cli 0.156.0`, `claude` 2.1.293 — experimental.

| run | command | result | evidence |
|---|---|---|---|
| checks | `npm run typecheck` / `lint` / `test` / `build` (singly) | pass, 110/110 fixtures | — |
| status | `node scripts/smoke.mjs status` | succeeded; plugin + MCP name listings complete, `truncated: false` | `.smoke/b229da41-…/evidence.json` |
| task | `node scripts/smoke.mjs task` | succeeded, `PONG` | `.smoke/c1abd1f3-…/evidence.json` |
| image | `node scripts/smoke.mjs image --confirm-spend-one-image` | **failed `OUTPUT_LIMIT`**; exactly one native image generated (10:31:23) | job stays failed |
| recovery | `node scripts/recover-smoke-image.mjs` (official `thread/read`, own thread, no new turn) | savedPath verified, `inline_result_match: true`, `copy_rehash_match: true` | `.smoke/recovered-owned/evidence-68951dd7-….json` |
| register | `npm run register` (dry run) | exit 3 inconclusive, not registered: the CLI writes not-found to **stderr** (exit 1, stdout empty), probe expected stdout. Fixed; final dry run pending parent readback | — |

Recovered file: `.smoke/recovered-owned/38631923-…/d5b2171a-be4b-4826-857c-b23457697aea.png`,
940955 bytes, SHA-256 `b4905bbc23a311ce7bf95dffff7b278d83b2390ae4976abe1db9255fc1e4723d`
(parent `shasum` matches; `sips`: png, 1254×1254).

Repairs after the failure: frame bound raised to 8 MiB with a ~1.3 MiB fixture; installer
probe now accepts the actual 2.1.293 not-found prefix on exactly one non-empty stream
(stderr as observed, or stdout); mixed or other output fails closed;
`CODEX_IMAGE_OUTPUT_ROOT` is forwarded by the installer.

## Limitations

- The repaired `codex_image_generate` path has **not** been re-run live; only one image was
  authorized. End-to-end image success is not claimed.
- The bridge never retries turns/generations; Codex internals may retry transport.
- Image editing is disabled and unverified.
- Prompts run as a general Codex agent with normal config/plugins/auth — no image-only guarantee.
- `npm run register -- --apply` not executed; the fixed probe has not been re-run live.
