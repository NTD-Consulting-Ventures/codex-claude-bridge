# Approvals: ask, bypass, deny

Codex runs every job under the same launch policy: `workspace-write` with the job's `cwd` as
the only writable root, no network, and approvals `on-request`. Whatever stays inside that
needs no approval. When Codex wants more (a command outside the sandbox, network access,
writes outside `cwd`, extra sandbox permissions), it sends an **approval request**. What
happens then is the approval mode.

| mode | what happens on an approval request |
|---|---|
| `ask` (default) | The job pauses and you decide in Claude Code. The same turn continues afterwards. |
| `bypass` | Every request is accepted at once, without asking. |
| `deny` | The job fails with `APPROVAL_REQUIRED` (the behaviour before 0.4.0). |

Set it with `CODEX_APPROVAL_MODE` when you register (see [setup](setup.md#approval-mode)).
`codex_status` shows the effective mode under `approvals`. A single job can pass
`approval_mode` to be **stricter** than the configured mode (`deny` < `ask` < `bypass`),
never more permissive; a more permissive value is refused before the job starts. An
invalid `CODEX_APPROVAL_MODE` in an existing registration falls back to `deny` and is
reported as `env_issue: "invalid"`.

## ask: pause, decide in Claude Code, resume

1. The job's state becomes `awaiting_approval`. Its wall clock stops, so time spent
   deciding never counts against `timeout_s`. `codex_task_wait` returns at once.
2. **Dialog in Claude Code.** When Claude Code supports MCP elicitation (it does since
   version 2.1.76), the bridge opens a dialog for the request while `codex_task_wait` is
   running: what Codex wants to run or change, where, and the reason it gave, with the
   choices *Decline* (preselected) and *Approve once*. Claude Code documents these
   dialogs during a task, so the bridge only opens one during that tool call, never out of
   the blue; the call stays open until you answer. Cancelling the call closes the dialog,
   and the next `codex_task_wait` opens it again. `codex_status` shows
   `approvals.claude_code_dialog`.
3. **Fallback.** Without dialog support (or if you dismiss the dialog without choosing),
   the request is listed in `pending_approvals` of `codex_task_status` / `codex_task_wait`.
   Claude shows it to you and answers with `codex_task_approve {job_id, approval_id,
   decision, request_summary}`. `request_summary` must be the request's one-line
   `summary`, copied exactly (otherwise `APPROVAL_SUMMARY_MISMATCH`), so the confirmation
   Claude Code shows you names what is being decided. That tool is marked so that Claude
   Code asks for your confirmation on **every** call, even if you allow-listed it.
4. The decision goes back to Codex and the same turn continues. A request nobody answers
   is declined after 10 minutes, and from then on that job's further requests are
   declined at once (nobody is answering). Cancelling the job declines its open requests;
   a request still open when the turn ends is declined as `run_ended` and is never shown
   afterwards.

Every request and its outcome are recorded: the job view shows the newest 10 in
`approvals` (`approvals_total` counts all) as
`{approval_id, requested_at, expires_at, request, decision, decided_by, decided_at}`, with
`decided_by` one of `claude_code_dialog`, `codex_task_approve`, `bypass`, `timeout`,
`cancelled`, `run_ended`, `not_displayable`.

### What a request shows

`request.kind` is `command`, `file_change` or `permissions`, plus what applies: the
`command` line (and `stdin: true` for input to an already running command), `cwd`,
`network_host`, the `files` a change would write (`add` / `delete` / `update`, with
`move_to`), a `grant_root`, or the extra `permissions`: `network`, `read` and `write`
paths and every sandbox `entries` item as `{access, target}`, where `target` is a path,
`glob:<pattern>` or `special:<kind>` (`special:root` is the whole filesystem). `summary`
puts it on one line. These values are **Codex's own text**: control characters become
spaces and invisible characters (bidi controls, zero-width and tag characters, line
separators) are shown as `\u{...}` escapes, but the text is untrusted. A prompt-injected
task can phrase a reason to talk you (or Claude) into approving. Read the command or
paths themselves, not the reason.

**A request that cannot be shown in full is declined without asking** (`decided_by:
"not_displayable"`): a command longer than 2,000 characters, no command at all, more than
25 paths, files or sandbox entries, an entry of an unknown shape, an unknown permission
kind, or a file change whose files Codex never announced. You never approve something you
were not shown. (`bypass` accepts these too; that is what it is for.)

### What a decision does

Every answer is a one-time decision for that one request: *accept* or *decline*, and for
permission requests a grant of exactly what was asked, for the current turn only. The
bridge never sends "approve for the session", never adds an execpolicy or network policy
rule and never changes your Codex configuration. A request from another thread or an
earlier turn is denied without asking. Requests that are not approvals (Codex asking for
free-text input, MCP elicitations from Codex's own MCP servers, dynamic tools, auth
refreshes) still fail the job as before.

## bypass

`bypass` accepts every approval request automatically: Codex can then run commands outside
the sandbox, use the network and write outside `cwd` whenever it asks to. Use it only for
work you would also run with Codex's own approvals turned off. Each accepted request is
still logged in the job's `approvals` with `decided_by: "bypass"`, so you can see afterwards
what was allowed. A job can opt back into asking with `approval_mode: "ask"`.

A narrower alternative: keep `ask` and let a Claude Code `Elicitation` hook answer the
dialogs of this server by your own rules (for example, accept only requests whose command
starts with `git `). See the Claude Code hooks reference for the `Elicitation` event.

## deny

The behaviour of 0.3.0 and earlier: the first approval request interrupts the turn,
terminates the process and fails the job with `APPROVAL_REQUIRED` and a coarse
`request_kind`. Nothing is approved.

## Limits and status

- At most 4 approval requests of one job can be open at the same time; further ones are
  denied (the job continues).
- 50 decision records are kept per job (the view shows the newest 10); finished jobs keep
  theirs while the job is retained (20 jobs).
- Verified with fixture tests and the MCP SDK (dialog round trip, dismissal, cancelled
  call, fallback, summary check, timeout, cancel, run end, incomplete requests, the
  request bound, bypass, deny, per-job tightening). Every response the bridge can send
  validates against the codex-cli 0.162.1 schemas. A live approval with a signed-in Codex
  has not been run for this release.
