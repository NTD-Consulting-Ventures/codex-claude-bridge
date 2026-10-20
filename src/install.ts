// Pure planning logic for scripts/register.mjs (portable install). It only
// builds argv and classifies `claude mcp get` results; spawning stays in the
// script (discovery: src/discover.ts). ~/.claude.json is never read or written.

import { BRIDGE_MODE_ENV, BRIDGE_MODE_INVALID_MESSAGE, isBridgeMode, resolveBridgeMode, type BridgeMode } from "./bridge-mode.js";
import { isJobTimeout, JOB_TIMEOUT_ENV, JOB_TIMEOUT_INVALID_MESSAGE } from "./limits.js";
import { resolveOutputRoot } from "./output-root.js";
export { resolveRegisteredJobTimeout } from "./limits.js";

/** Server ID used for new registrations. */
export const SERVER_NAME = "codex-claude-bridge";
/** Server ID of registrations made by earlier releases; detected, never changed. */
export const LEGACY_SERVER_NAME = "codex-image-mcp";
/** Every ID probed before any add, so a second registration is never created. */
export const KNOWN_SERVER_NAMES: readonly string[] = [SERVER_NAME, LEGACY_SERVER_NAME];
const MAX_PROBE_TEXT = 4096;
const MAX_READBACK_TEXT = 64 * 1024;

export type RootChoice = { ok: true; path: string; source: "default" | "env" } | { ok: false; reason: string };

/**
 * Image output root forwarded via `-e`, resolved by the same resolver the
 * server uses (src/output-root.ts): unset → ~/codex-images; set-but-invalid
 * (including empty) fails closed.
 */
export function resolveRegisteredOutputRoot(env: NodeJS.ProcessEnv, homedir?: () => string): RootChoice {
  const r = resolveOutputRoot(env, homedir);
  return r.ok ? { ok: true, path: r.path, source: r.source } : { ok: false, reason: r.message };
}

/**
 * Bridge mode requested for the registration, resolved by the same resolver
 * the server uses (src/bridge-mode.ts). `persist` is the mode to store, only
 * when CODEX_BRIDGE_MODE was explicitly set; unset stores nothing (the server
 * then defaults to general). Set-but-invalid fails closed with a static reason.
 */
export type ModeChoice = { ok: true; mode: BridgeMode; persist: BridgeMode | undefined } | { ok: false; reason: string };

export function resolveRegisteredBridgeMode(env: NodeJS.ProcessEnv): ModeChoice {
  const r = resolveBridgeMode(env);
  if (!r.ok) return { ok: false, reason: r.message };
  return { ok: true, mode: r.mode, persist: r.source === "env" ? r.mode : undefined };
}

/**
 * Env persisted into the registration: always the validated absolute Codex
 * path and output root; CODEX_BRIDGE_MODE only when a mode is passed, and
 * CODEX_TASK_WALL_SECONDS only when a job timeout is passed (src/limits.ts).
 */
export function registrationEnv(codex: string, outputRoot: string, mode?: BridgeMode, timeoutS?: number): Record<string, string> {
  if (mode !== undefined && !isBridgeMode(mode)) throw new TypeError(BRIDGE_MODE_INVALID_MESSAGE);
  if (timeoutS !== undefined && !isJobTimeout(timeoutS)) throw new TypeError(JOB_TIMEOUT_INVALID_MESSAGE);
  const env: Record<string, string> = { CODEX_BIN: codex, CODEX_IMAGE_OUTPUT_ROOT: outputRoot };
  if (mode !== undefined) env[BRIDGE_MODE_ENV] = mode;
  if (timeoutS !== undefined) env[JOB_TIMEOUT_ENV] = String(timeoutS);
  return env;
}

export function addArgs(node: string, serverJs: string, codex: string, outputRoot: string, mode?: BridgeMode, timeoutS?: number): string[] {
  const env = Object.entries(registrationEnv(codex, outputRoot, mode, timeoutS)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // Name must precede -e: claude 2.1.293 parses -e as variadic, so a name placed
  // after the last -e is swallowed as another env entry.
  return ["mcp", "add", "--transport", "stdio", "--scope", "user", SERVER_NAME, ...env, "--", node, serverJs];
}

export interface ProbeResult {
  status: number | null;
  signal: string | null;
  error?: { code?: string } | undefined;
  stdout?: string | null;
  stderr?: string | null;
}

export type ProbeVerdict = "absent" | "exists" | "cli_missing" | "inconclusive";

/**
 * Exact empty-config answer (no MCP servers configured at all), observed with
 * isolated CLAUDE_CONFIG_DIRs on claude 2.1.293 and 2.1.295: exit 1, stdout
 * empty, stderr exactly this text.
 */
export const emptyConfigNotFound = (name: string): string => `No MCP server named "${name}". Run \`claude mcp add\` to add one.\n`;
export const EMPTY_CONFIG_NOT_FOUND = emptyConfigNotFound(SERVER_NAME);

/**
 * The official named diagnostic. It is what proves absence; the listing that
 * may follow is informational and may be incomplete (claude.ai connectors,
 * truncation), so absence is never inferred from the listing alone.
 */
export const namedAbsent = (name: string): string => `No MCP server named "${name}". `;
export const NAMED_ABSENT = namedAbsent(SERVER_NAME);
const CONFIGURED_SERVERS = "Configured servers: ";
/**
 * Truncation suffix appended after the last listed name, observed with claude
 * 2.1.295 (19 servers: 8 listed, then " (and 11 more — run `claude mcp list`
 * to see all)"). Matched as a whole; the count must be a positive integer.
 */
const TRUNCATION_SUFFIX = / \(and ([1-9]\d{0,4}) more — run `claude mcp list` to see all\)$/;
/** Conservative local server identifier. */
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** claude.ai connector display name, e.g. "claude.ai Gmail": words separated by single spaces. */
const CONNECTOR = /^claude\.ai [A-Za-z0-9][A-Za-z0-9._&+'()-]*(?: [A-Za-z0-9._&+'()-]+){0,7}$/;
/** Plugin-provided server, e.g. "plugin:github:github". */
const PLUGIN_SERVER = /^plugin:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- deliberately matches control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function wellFormedName(n: string): boolean {
  return n.length <= 96 && (SERVER_ID.test(n) || CONNECTOR.test(n) || PLUGIN_SERVER.test(n));
}

/** Parses the (possibly truncated) configured-servers list; null when anything is not understood. */
export function parseConfiguredList(list: string): { names: string[]; truncated: boolean; more: number } | null {
  const m = TRUNCATION_SUFFIX.exec(list);
  const items = (m ? list.slice(0, m.index) : list).split(", ");
  if (items.length === 0 || !items.every(wellFormedName)) return null;
  if (new Set(items).size !== items.length) return null;
  return { names: items, truncated: m !== null, more: m ? Number(m[1]) : 0 };
}

/**
 * Fail closed: "absent" only on exit 1, no signal/error, stdout byte-empty and
 * stderr exactly one bounded line (single terminal "\n", no control
 * characters) that is either
 *  - exactly emptyConfigNotFound(name), or
 *  - namedAbsent(name) + CONFIGURED_SERVERS + a non-empty ", "-separated list
 *    of distinct well-formed names (local ids, claude.ai connectors, plugin
 *    servers), optionally followed by the observed parenthesized truncation
 *    suffix, that does not name `name`.
 * Warnings, other streams, unknown wording or names, a diagnostic for another
 * name, and a listing that names the target are inconclusive. Exit 0 is an
 * existing registration in any scope.
 */
export function classifyProbe(p: ProbeResult, name: string = SERVER_NAME): ProbeVerdict {
  if (p.error?.code === "ENOENT") return "cli_missing";
  if (p.error || p.signal !== null) return "inconclusive";
  if (p.status === 0) return "exists";
  if (p.status !== 1) return "inconclusive";
  const stdout = p.stdout ?? "";
  const stderr = p.stderr ?? "";
  if (stdout !== "") return "inconclusive";
  if (stderr === emptyConfigNotFound(name)) return "absent";
  if (stderr.length > MAX_PROBE_TEXT || !stderr.endsWith("\n")) return "inconclusive";
  const line = stderr.slice(0, -1);
  if (CONTROL.test(line)) return "inconclusive";
  const anchor = namedAbsent(name) + CONFIGURED_SERVERS;
  if (!line.startsWith(anchor)) return "inconclusive";
  const parsed = parseConfiguredList(line.slice(anchor.length));
  if (parsed === null || parsed.names.includes(name)) return "inconclusive";
  return "absent";
}

/** Content-free summary of a probe for diagnostics (no names, paths or text are echoed). */
export function describeProbe(p: ProbeResult, name: string = SERVER_NAME): string {
  const lines = (s: string | null | undefined): number => (s ? s.split("\n").filter((l) => l !== "").length : 0);
  return [
    `exit=${String(p.status)}`,
    `signal=${p.signal ?? "none"}`,
    `error=${p.error?.code ?? (p.error ? "unknown" : "none")}`,
    `stdout_chars=${p.stdout?.length ?? 0}`,
    `stderr_chars=${p.stderr?.length ?? 0}`,
    `stderr_lines=${lines(p.stderr)}`,
    `named_absent_prefix=${(p.stderr ?? "").startsWith(namedAbsent(name)) ? "yes" : "no"}`,
  ].join(" ");
}

export interface ExpectedRegistration {
  node: string;
  serverJs: string;
  env: Record<string, string>;
}

/**
 * Verifies the official `claude mcp get <name>` readback after `mcp add`
 * (text output; the CLI offers no structured format). Requires exit 0 and,
 * exactly once each: the "<name>:" header, "  Scope: User config…",
 * "  Type: stdio", "  Command: <node>", "  Args: <server.js>" (one argument,
 * so the space-joined display is unambiguous) and an "  Environment:" block
 * whose "    KEY=VALUE" entries equal the expected env exactly. Other lines
 * (health status, hints) are ignored. Returns the problems found.
 */
export function verifyReadback(p: ProbeResult, exp: ExpectedRegistration, name: string = SERVER_NAME): string[] {
  if (p.error || p.signal !== null || p.status !== 0) return [`claude mcp get did not succeed (${describeProbe(p)})`];
  const out = p.stdout ?? "";
  if (out.length > MAX_READBACK_TEXT) return ["readback output too large"];
  const lines = out.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const problems: string[] = [];
  const once = (label: string, pred: (l: string) => boolean): void => {
    const n = lines.filter(pred).length;
    if (n !== 1) problems.push(`${label}: expected exactly one matching line, found ${n}`);
  };
  once("header", (l) => l === `${name}:`);
  if (KNOWN_SERVER_NAMES.some((n) => n !== name && lines.includes(`${n}:`))) problems.push("header: another known server ID");
  once("scope", (l) => l.startsWith("  Scope: User config"));
  if (lines.some((l) => l.startsWith("  Scope: ") && !l.startsWith("  Scope: User config"))) problems.push("scope: not user");
  once("type", (l) => l === "  Type: stdio");
  once("command", (l) => l === `  Command: ${exp.node}`);
  if (lines.filter((l) => l.startsWith("  Command: ")).length !== 1) problems.push("command: unexpected command line");
  once("args", (l) => l === `  Args: ${exp.serverJs}`);
  if (lines.filter((l) => l.startsWith("  Args: ")).length !== 1) problems.push("args: unexpected args line");
  const start = lines.indexOf("  Environment:");
  const env: Record<string, string> = {};
  if (start < 0 || lines.lastIndexOf("  Environment:") !== start) {
    problems.push("environment: expected exactly one block");
  } else {
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith("    "); i++) {
      const entry = lines[i]!.slice(4);
      const eq = entry.indexOf("=");
      if (eq <= 0 || Object.hasOwn(env, entry.slice(0, eq))) {
        problems.push("environment: malformed or duplicate entry");
        continue;
      }
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const want = Object.entries(exp.env).sort();
    const got = Object.entries(env).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      problems.push("environment: entries differ from the requested CODEX_BIN / CODEX_IMAGE_OUTPUT_ROOT / CODEX_BRIDGE_MODE / CODEX_TASK_WALL_SECONDS");
    }
    if (exp.env[BRIDGE_MODE_ENV] !== env[BRIDGE_MODE_ENV]) {
      problems.push(`environment: ${BRIDGE_MODE_ENV} is not the requested ${exp.env[BRIDGE_MODE_ENV] ?? "(unset)"}`);
    }
  }
  return problems;
}
