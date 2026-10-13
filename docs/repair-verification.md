# Repair verification (review task t_1e1d4a26)

Scope: bounded repair of job deadline/cancellation, RPC-timeout root cause, and
tool annotations. **All verification below is deterministic and fixture-only**
(scripted fake app-server, injected version probe, temp directories). No live
native Codex turn, image generation, registration or paid plugin test was run
for this repair, so there is **no live end-to-end evidence for the repaired
behaviour**. Earlier live evidence (`docs/runtime-verification.md`) predates
this repair and is not re-claimed here.

## What changed

1. **Whole-job deadline and cancellation (`src/jobs.ts`, `src/server.ts`,
   `src/image-service.ts`).**
   - `JobManager` owns the wall-clock deadline: it aborts the job signal with
     reason `"TIMEOUT"`; a manual cancel/shutdown aborts with `"CANCELLED"`.
     `AbortController` keeps only the first reason, so the first root cause
     wins. The session maps the abort reason to the same typed code.
   - Image post-processing (output `mkdir`, verified copy, version probe) now
     runs inside that deadline/cancellation: each step is awaited to
     completion (no `Promise.race` abandoning writing work), and the signal is
     checked between awaits.
   - The owned UUID output directory is registered with the job as soon as it
     is created. If the job does not end in success — failure, cancel, or
     deadline, including during the version probe after collection — the job
     manager awaits removal of that directory (and only that directory)
     before releasing the job.
   - An abort observed before the runner's result is processed overrides
     success: an accepted cancel can no longer end as `succeeded`. Once the
     runner has settled, further cancels return `cancel_requested: false`.
2. **RPC timeout root cause (`src/codex-client.ts`).** A per-request timeout
   now closes the client with reason `timeout` instead of `closed`, so the
   session's close observer records `TIMEOUT` (with the lifecycle phase)
   instead of overriding it with `PROCESS_EXITED`. Approval/unsupported-request
   and protocol errors that occur first remain the root cause.
   `RunOptions.rpcTimeoutMs` is an internal, test-only knob; MCP callers have
   no new parameters.
3. **Annotations (`src/server.ts`).** `codex_task_start` and
   `codex_image_generate` now declare `destructiveHint: true` (conservative:
   the delegated Codex uses the user's normal config, plugins and MCP servers,
   and the image tool writes files).

## Settled BUSY semantics

A job is "active" (new starts return `BUSY`) until **all** of:

- the runner promise has settled (Codex process kill requested, every awaited
  filesystem step and the version probe finished), and
- owned partial output has been removed when the job did not succeed.

BUSY is never released while writing work is still outstanding. Consequence:
`makeShutdown` waits only `SHUTDOWN_GRACE_MS` and may return while a job is
still settling; the job then remains active until its in-flight step returns.
Shutdown grace does **not** guarantee cleanup before process exit: if the
process exits first, the in-flight step and owned-dir removal may never run.

Deadline semantics: the job deadline aborts the whole job (turn and
post-processing) and fixes the root cause as `TIMEOUT`, but final settlement
deliberately awaits outstanding filesystem IO and the version probe. It is
**not** a strict terminal-latency promise: a job can stay `running`/BUSY past
its wall limit until that IO returns.

Cleanup semantics: removal of the owned UUID dir is best effort. `rm` errors
are swallowed (never reported, no path leaked) and the job still ends with its
root-cause error and a withheld (`null`) result; deletion cannot be guaranteed
under permission or filesystem failures.

## Deterministic coverage

`test/server.test.ts` (production `ToolHandler`). Two kinds of gates:

- **After-step gates** (internal `imageAfterStep` hook): held *after* the
  output mkdir / copy has already completed — they test the between-step
  checkpoints, not in-flight IO. The `versionProbe` gate holds the probe
  itself in flight.
  - cancel at the after-mkdir / after-copy gate and during the version probe:
    BUSY held, second cancel is a no-op, then `cancelled` / `CANCELLED`,
    owned dir removed;
  - deadline (150 ms wall) at the same points: BUSY held past the deadline,
    later cancel refused, final `TIMEOUT`, owned dir removed;
  - cancel before deadline, deadline passes while gated: stays `CANCELLED`;
  - shutdown at the after-copy gate: grace expires without releasing BUSY; on
    release the job ends `cancelled` with output removed.
- **True in-flight IO gates** (`t.mock.method` on `fs.promises`, restored
  automatically after each test; this file's tests run sequentially; every
  gate wait is bounded and gates are released in `finally`):
  - original reproducer: `fsp.mkdir(outputRoot)` held *before* the real mkdir
    is called, wall 50 ms, wait 100 ms — and the cancel equivalent: BUSY and
    `running` throughout, late cancel refused, then `TIMEOUT` / `CANCELLED`
    (never `succeeded`), result `null`;
  - destination write: `fsp.open` is wrapped so the returned `FileHandle`'s
    `writeFile` for the owned destination path is held before the real write;
    deadline (50 ms) and cancel variants: BUSY, no `rm` while the write is
    outstanding (event order `write-start`, `write-done`, then `rm` only),
    final `TIMEOUT` / `CANCELLED`, destination and owned dir removed, source
    image intact, unrelated output-root sentinel intact.
- cancel after completion: refused, result and files intact;
- version probe returning failure: still succeeds with `codex_version: null`;
- annotation regression for `destructiveHint`.

`test/jobs.test.ts` (`JobManager`): failed and cancelled runners with a gated
owned cleanup stay active/`running` (BUSY, late cancel refused) until cleanup
settles; a rejecting cleanup is withheld and the job still ends with its root
cause.

`test/image-service.test.ts`: partial collection failure (one valid, then one
invalid source) removes only the owned UUID dir; output-root sentinel and both
sources intact.

`test/session.test.ts`:

- withheld `initialize`, `model/list`, `thread/start`, `turn/start` with a
  20 ms internal RPC deadline: `TIMEOUT` with diagnostic phase `initialize`,
  `model_select`, `thread_start`, `turn_start`; the method is sent once (no
  retry), no `turn/interrupt`, transport killed;
- approval request during a withheld RPC keeps `APPROVAL_REQUIRED`;
- job signal abort reason `TIMEOUT` vs `CANCELLED` mapping.

`test/codex-client.test.ts`: request timeout reports close reason `timeout`.

Commands run (repair2 follow-up): `npm run typecheck`, `npm run lint`,
`npm test` (135 tests, all passing; includes `npm run build`). Parent-verified
for repair1: `npm ci`, typecheck, lint, 127 tests, build, `npm audit` (0),
`git diff --check`.

## Harness metadata (sanitized)

- Official Claude repair1: actual raw result `success`, 43 turns,
  261146 ms, model `claude-opus-5-5`. Constraints: this repo only, no commit,
  no live Codex turn, no image generation, no registration, no paid plugins,
  no credential or `.smoke` reads. Raw harness transcripts/result paths are
  intentionally ignored and not recorded here.
- Repair2 (this follow-up, deterministic tests + docs only, no runtime
  redesign): outcome pending; it is finalized in the parent handoff, not here.

## Remaining limitations (unchanged, stated honestly)

- The "generate exactly one image, no other tools" instruction is a prompt,
  not enforced by Codex; native sandbox/approvals are the only enforcement.
- Image editing is not exposed (unverified).
- Version reporting is limited to the sanitized `codex --version` output and
  may be `null`.
- The original live smoke failed with `OUTPUT_LIMIT`; the recovered artifact
  in earlier evidence came from the recovery script, not a repaired live run.
- The real version probe is not killed on abort; it is bounded by its own
  timeout and awaited, so cancel/deadline during it takes effect when it
  returns.
- Filesystem steps cannot be interrupted mid-call; a hung filesystem keeps
  the job BUSY past its deadline. If the process exits after shutdown grace,
  an in-flight partial output directory may remain.
- Owned-output cleanup is best effort and may leave files behind on
  permission/filesystem errors (errors are withheld, never reported).
- TOCTOU caveats in `src/paths.ts` still apply.
