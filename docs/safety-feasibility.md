# Safety Feasibility Gate — codex-cli 0.156.0 image-only operation

**Verdict: BLOCKED (not proven safe).** This is a *source-audit* verdict. It is not a finding
that image-only operation is impossible. Some requirements are proven unachievable through a
particular route (for example, `mcp_servers={}` cannot clear inherited servers). Others are only
unresolved because the audit is incomplete or because no runtime verification was allowed.
Each item below is labelled with one of:

- **ENFORCED**: a source-backed, machine-enforced mechanism exists.
- **ACHIEVABLE (untested)**: a plausible mechanism exists in source but was not run.
- **UNRESOLVED**: the audit did not reach a conclusion. This is not evidence of impossibility.
- **NOT POSSIBLE via route X**: the source shows that route cannot satisfy the requirement.

No implementation was scaffolded. No test, model turn or image generation was executed in any phase.

## Scope of evidence (what was and was not done)

- Installed binary: `/Users/niki/.local/bin/codex --version` → `codex-cli 0.156.0`.
  Inspected `--help`, `app-server --help`, `app-server generate-json-schema --help`.
  The `codex features --help` and `codex exec --help` calls were denied by the harness and never ran.
- Schema: `codex app-server generate-json-schema --experimental --out research/schema-0.156.0`.
- Source: official `openai/codex` tag `rust-v0.156.0`, fetched with bounded `curl` into
  `research/source-0.156.0/` (paths mirror upstream). The tree listing is in
  `research/source-meta/tree.json`. Only about 53 individual files were fetched. **No crate was
  fetched in full.** The tag matches the installed version string, but that does not prove it is
  byte-identical to the installed binary.
- No auth or config files were read, and nothing outside the repo was changed.
- `.protocol-research/` and `.app-server-reference.md` are non-authoritative and were not relied on.
- Phase 2 hit its max-turn limit (45) before updating this document. This document was written in
  phase 3 from the files already fetched; no new fetching was done. All line numbers below were
  re-checked against the local fetched copies in phase 3.

Paths below are relative to `research/source-0.156.0/codex-rs/`.

## Corrections to the phase-1 version

1. **Extension count/list was wrong.** Phase 1 listed 15 crate names but called it "14". It also
   included names (agent, connectors, items, guardian-reviewer) that were never checked against
   app-server registration. What actually matters is what app-server installs.
   `app-server/src/extensions.rs:67-124` installs 12 contributors from 11 crates. Two of them are
   conditional:
   - queue (`:71-73`), only if `queue_service` is set
   - history-notes (`:74`)
   - agent-message-board, via `codex_core::install_agent_message_board` (`:75`)
   - goal (`:76-89`), only if `state_db` is set
   - git-attribution (`:90-95`)
   - guardian-v2 (`:96`)
   - memories (`:97`)
   - mcp (`:98`) and mcp plugins (`:99`)
   - web-search (`:100`)
   - image-generation (`:101-103`)
   - skills (`:110-123`)
2. **"Extension tools are registered unconditionally" was wrong.**
   `core/src/tools/spec_plan.rs:1427-1442` adds core-side filtering for only `web.run` and
   `image_gen.imagegen`. However, each `ToolContributor::tools()` gates itself (see A2).
3. **"Image save bypasses the sandbox" is not a blocker by itself.** The host write is the
   intended output. What matters is whether `save_root` can be confined (see A4).
4. **Client denial of approvals is required, not forbidden.** It is defense in depth. It does not
   replace removing the tools that generate the requests.

## A1. Tool allowlist: NOT POSSIBLE via app-server/CLI; denylist route remains UNRESOLVED

`ext/extension-api/src/tool_policy.rs:6-14`: `ToolPolicy.allowed_tools` is the only allowlist.
It is supplied through `ExtensionDataInit`.

`app-server/src/request_processors/thread_processor.rs:1464-1467`:
```rust
        let mut thread_extension_init = ExtensionDataInit::new();
        if !selected_capability_roots.is_empty() {
            thread_extension_init.insert(selected_capability_roots);
        }
```
App-server never inserts a `ToolPolicy`. No `allowedTools`, `toolPolicy` or `toolChoice` field
exists in the generated experimental schema. Hosted specs are filtered only by that policy, which
by default allows everything (`spec_plan.rs:355`).

**Consequence:** for app-server clients, image-only operation can only be a *denylist*. A
denylist is not impossible in principle, but it is only as complete as the audit in A2.

## A2. Tool sources and gating (partial audit)

`spec_plan.rs:149-173` builds the registry from these sources:
- core tools (`:150`)
- MCP tools (`:152-159`)
- extension executors (`:167-172`)
- dynamic tools (`:173`)
- hosted specs (`:174`)

| Source | Gate found in source | Status |
|---|---|---|
| Core shell/exec, request_permissions, apply_patch, view_image | `!environment_mode.has_environment()` / `has_environment()` at `spec_plan.rs:1036`, `:1158`, `:1211`, `:1225`. `environments: []` gives "Empty disables environment access" (`app-server-protocol/src/protocol/v2/thread.rs:136-144`, experimental) | ENFORCED (source), untested |
| Dynamic tools | `thread_processor.rs:1448`: `dynamic_tools.unwrap_or_default()`, so omitting them means none | ENFORCED (source) |
| image-generation | `ext/image-generation/src/extension.rs:83-107`: only if `config.available` (OpenAI provider/auth, `:41-43`); core filter `spec_plan.rs:1433-1437` | Intended tool |
| web-search (`web.run`) | `ext/web-search/src/extension.rs:127-132` (`config.available`); core filter `spec_plan.rs:1429-1432` also requires the web search mode to not be `Disabled` | ACHIEVABLE via `web_search="disabled"`, untested |
| memories | `ext/memories/src/extension.rs:143-148`: requires `config.enabled && config.dedicated_tools`. Feature `memories` defaults to false (`features/src/lib.rs:1148-1150`) | Likely off by default. How `enabled` is derived was not traced, so UNRESOLVED |
| history-notes | `ext/history-notes/src/extension.rs:47-53`: requires `token_budget.use_history_notes_extension`, an OpenAI provider and Codex-backend auth; tools at `:154-178` | Off unless that config key is set. Config value not traced, so UNRESOLVED |
| goal | `ext/goal/src/extension.rs:540-545`: `runtime.tools_visible()`. The extension config is fed by `Feature::Goals` (`app-server/src/extensions.rs:84-87`, default true at `features/src/lib.rs:1668-1670`) | `tools_visible()` body not fetched/traced, so UNRESOLVED |
| agent-message-board | `ext/agent-message-board/src/extension.rs:86-103`: tools only if a `Binding` exists in the thread store | Binding creation conditions not traced, so UNRESOLVED |
| skills | `ext/skills/src/extension.rs:271-287` delegates to `build_skill_tools`; no gate was inspected | UNRESOLVED |
| git-attribution, guardian-v2, queue, mcp extension crates | No `impl ToolContributor` in the *fetched* files (grep). Their crates were only partially fetched | UNRESOLVED (absence not established) |
| MCP server tools / resource tools | Driven by the effective `mcp_servers` config (`spec_plan.rs:152-159`, `:1085`). See A3 | Depends on A3 |
| multi_agent, apps, plugins, tool_suggest, browser_use, computer_use | Features default to true (`features/src/lib.rs:1314-1316`, `:1344-1346`, `:1422-1424`, `:1434-1436`, `:1488-1490`, `:1506-1508`). Phase 1 cited gates at `spec_plan.rs:643-655`, `:1195-1209`, `:1241-1363` for some of them. These were **not re-verified in phase 3**. browser_use/computer_use gates were never traced | UNRESOLVED |

Without a model turn, the final tool list sent to the model has **not** been observed.

## A3. Inherited config / MCP / hooks

**`-c mcp_servers={}` is NOT POSSIBLE as a way to clear inherited MCP servers.**
`config/src/loader/mod.rs:338-339` merges the CLI override layer with `merge_toml_values`.
`config/src/merge.rs:94-148` merges tables recursively: each overlay key is merged into or
inserted into the base table, and base keys are never removed:
```rust
    if let TomlValue::Table(overlay_table) = overlay
        && let TomlValue::Table(base_table) = base
    {
    ...
        for (key, value) in overlay_table {
            path.push(key.clone());
            if let Some(existing) = base_table.get_mut(&key) {
                merge_toml_values_at_path(existing, &value, path);
            } else {
                base_table.insert(key, normalized_with_key_aliases(&value, path));
            }
```
An empty overlay table therefore leaves every user-defined server in place. Per-server
`mcp_servers.<name>.enabled=false` would require knowing the server names, which means reading
user config, and that is forbidden. (The `enabled` key itself was not verified.) Scalar feature
overrides such as `features.hooks=false` *do* replace values (`merge.rs:149-150`). Whether
`hooks=false` suppresses every configured hook was not traced, so that is UNRESOLVED.

**`ignore_user_config` exists but is not client-reachable in the fetched sources.**
- `config/src/state.rs:43-57` defines `LoaderOverrides.ignore_user_config` and
  `ignore_project_config`.
- `config/src/loader/mod.rs:507-514` replaces the user layer with an empty table when
  `ignore_user_config` is set.
- In app-server it is set only in two places:
  - `load_default_config` (`app-server/src/config_manager.rs:270-272`). This is used only as the
    fallback when the user config fails to load (`app-server/src/lib.rs:569-577`).
  - `ignore_project_config` is set only in `load_non_project_config` (`config_manager.rs:160-162`).
- No CLI flag or protocol field setting either one was found. The CLI arg parsing crate was not
  fetched, so that remains UNRESOLVED rather than NOT POSSIBLE.

**Isolated `CODEX_HOME` is ACHIEVABLE (untested) and is the most promising route.**
- `utils/home-dir/src/lib.rs:13-18` and `:23-50`: `CODEX_HOME` is honored if it is set and
  non-empty. It must be an existing directory and is canonicalized.
- The user layer is `${CODEX_HOME}/config.toml` (`config/src/loader/mod.rs:125`). An empty,
  repo-owned `CODEX_HOME` therefore yields no user `mcp_servers`, hooks or plugins from `~/.codex`.
- Credentials:
  - `login/src/auth/storage.rs:154-155`: file storage is `<codex_home>/auth.json`.
  - `:238-248`: keyring entries are keyed by `cli|<sha256(canonical codex_home)[..16]>`.
  - `:511-528`: modes are File, Keyring, Auto and Ephemeral.

  So an isolated home **does not see** existing `~/.codex` credentials, in either the file or the
  keyring. It needs its own official login, and that login would store a new credential under the
  isolated home or a new keyring key. The default store mode was not traced. No login was attempted
  and no credentials were read.

**Layers that are still inherited even with an isolated home:**
- **System/managed layers** (`config/src/loader/mod.rs:111-116`, `:423-464`): legacy
  `/etc/codex/managed_config.toml`, macOS MDM managed preferences and the cloud config bundle.
  They cannot be bypassed from a client. Whether any exist on this machine is unknown, because
  reading them is forbidden. Status: UNRESOLVED; this is an environment fact, not a code
  impossibility.
- **Project layers** (`loader/mod.rs:127-129`, `:333-340`): `./config.toml`, `.codex/config.toml`
  up the tree and at the repo root. Per the doc comment these are "loaded but disabled when
  untrusted". Trust is stored in `codex_home`, so a fresh home starts with nothing trusted.
  However, see A5 on trust persistence. Status: UNRESOLVED.

## A4. Filesystem reads and writes for the image path

- **Save root.** App-server resolves `save_root` as `config.codex_home`
  (`app-server/src/extensions.rs:101-103`). The file is written under it
  (`ext/image-generation/src/artifact.rs`, dir `generated_images`) using
  `LOCAL_FS ... /*sandbox*/ None` with `follow_symlinks: true`
  (`ext/image-generation/src/tool.rs:296-315`). There is no separate save-root override.
  The only lever is `CODEX_HOME`. With a fresh, repo-owned `CODEX_HOME` that contains no
  symlinks, the output lands inside that directory. Status: ACHIEVABLE (untested). The write is
  intended and is not a blocker.
- **Reference-image reads.** With no environment, model-supplied `referenced_image_paths` are
  refused before any read happens (`tool.rs:442-447`):
  ```rust
          (false, None) => {
              let Some(environment) = environments.first() else {
                  return Err(FunctionCallError::RespondToModel(
                      "referenced image paths are unavailable in this session".to_string(),
  ```
  Status: ENFORCED (source) under `environments: []`, untested.
- **Other unintended reads.** The config loader itself reads system/managed/project files (A3).
  Unread extension crates may read state; for example, memories reads under `codex_home`
  (`ext/memories/src/extension.rs:150-156`) when enabled. Status: UNRESOLVED.

## A5. Writes from thread/start

`thread_processor.rs:1350-1376`: trust is persisted to `codex_home` only if all of these hold:
- `requested_cwd.is_some()`
- the project is untrusted and not projectless
- the effective permissions can write the cwd (`:1354-1358`) or are `Disabled`/`External`

With `sandbox: "read-only"` (a Managed profile), the cwd should not be writable. Omitting `cwd`
avoids the branch entirely. If it is ever triggered with an isolated `CODEX_HOME`, it writes only
into that home. Status: ACHIEVABLE (untested). Separately, non-ephemeral threads persist rollout
and state under `codex_home`, but `ephemeral` exists (`thread.rs:114-115`). That persistence path
was not traced.

## A6. Approvals and server→client requests

- `approvalPolicy` (experimental nested) and `sandbox` are on thread/start (`thread.rs:86-94`).
- The client **must** deny every approval, elicitation and user-input request. The task requires
  this.
- Client denial is not sufficient alone. The tools and MCP servers that originate such requests
  should also be absent, which depends on A2/A3.

Status: client-side denial is implementable. Source removal is UNRESOLVED.

## A7. Network

The image backend calls the provider in-process (`ext/image-generation/src/extension.rs:97-103`).
Other in-process HTTP users exist: git-attribution receives an `http_client_factory`
(`app-server/src/extensions.rs:90-95`), and history-notes uses the provider backend. No
per-destination policy for in-process traffic was found in the fetched files.

Status: restricting network to the image backend only is UNRESOLVED. An external
(OS/firewall-level) control may be needed. That would be a separate decision.

## Remaining blockers (precise)

1. **No machine-enforced allowlist is reachable** (A1, proven for app-server/schema). Safety rests
   on a denylist, so it rests on 2–5.
2. **Incomplete contributor audit** (A2): the skills, goal (`tools_visible`), agent-message-board
   (`Binding`), git-attribution, guardian-v2, queue and mcp crates, plus the browser_use/
   computer_use/apps/plugins gates, are not traced to a disabling config.
3. **System/managed config layers** are inherited and unverifiable without reading host config
   (A3).
4. **Hooks:** it is not verified that `features.hooks=false` suppresses all hook execution (A3).
5. **Network egress** to non-image destinations is not constrained in-process (A7).
6. **No runtime verification:** the actual tool list, the isolated-`CODEX_HOME` login and the
   save path were never exercised.

## Candidate configuration (NOT validated; do not implement until 2–6 are resolved)

- Run with `CODEX_HOME=<fresh repo-owned dir>` and log in there through the official login.
- On thread/start: `environments: []`, no `dynamicTools`, `sandbox: "read-only"`,
  `approvalPolicy: "never"`, `ephemeral: true`, no `cwd`.
- Overrides: `web_search="disabled"` and
  `features.{shell_tool,unified_exec,view_image,hooks,multi_agent,apps,plugins,tool_suggest,browser_use,computer_use,goals,skill_search}=false`.
- The client denies every server→client request.

## Options

- (a) A custom in-process host that sets `ToolPolicy { allowed_tools: Some([image_gen.imagegen]) }`.
  This is the only route to a true allowlist.
- (b) Finish the A2 audit by fetching the remaining crates in full, then confirm the tool list in
  a separately approved bounded run under the candidate configuration.
- (c) A different image backend.
