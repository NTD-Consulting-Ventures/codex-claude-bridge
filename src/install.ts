// Pure planning logic for scripts/register.mjs (portable install). It only
// builds argv and classifies `claude mcp get` results; spawning stays in the
// script. ~/.claude.json is never read or written.

import path from "node:path";
import { resolveOutputRoot } from "./output-root.js";
import { resolveCodexBin } from "./process-transport.js";

export const SERVER_NAME = "codex-image-mcp";
const MAX_PROBE_TEXT = 4096;

function absoluteNormalized(raw: string): boolean {
  return !raw.includes("\0") && path.isAbsolute(raw) && path.normalize(raw) === raw;
}

export type BinChoice = { ok: true; path: string; source: "env" | "default" } | { ok: false; reason: string };

/** CLAUDE_BIN (absolute, normalized) or the `claude` found on PATH. Set-but-invalid fails closed. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv): BinChoice {
  const raw = env.CLAUDE_BIN;
  if (raw === undefined || raw === "") return { ok: true, path: "claude", source: "default" };
  if (!absoluteNormalized(raw)) return { ok: false, reason: "CLAUDE_BIN must be an absolute normalized path" };
  return { ok: true, path: raw, source: "env" };
}

/** Codex binary the registered server will use; CODEX_BIN is forwarded via `-e` only when set. */
export function resolveRegisteredCodexBin(env: NodeJS.ProcessEnv): BinChoice {
  const r = resolveCodexBin(env);
  if (r.path === null) return { ok: false, reason: "CODEX_BIN must be an absolute normalized path" };
  return { ok: true, path: r.path, source: r.source };
}

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

export function addArgs(node: string, serverJs: string, codex: BinChoice & { ok: true }, outputRoot: string | null = null): string[] {
  const env = codex.source === "env" ? ["-e", `CODEX_BIN=${codex.path}`] : [];
  if (outputRoot !== null) env.push("-e", `CODEX_IMAGE_OUTPUT_ROOT=${outputRoot}`);
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
 * Exact empty-config answer of `claude` 2.1.293 (no MCP servers configured at
 * all), verified with an isolated CLAUDE_CONFIG_DIR: exit 1, stdout empty,
 * stderr exactly this text. Only this byte-exact form is accepted.
 */
export const EMPTY_CONFIG_NOT_FOUND = `No MCP server named "${SERVER_NAME}". Run \`claude mcp add\` to add one.\n`;

/**
 * Prefix of the configured-servers answer of `claude` 2.1.293, verified with an
 * isolated CLAUDE_CONFIG_DIR (receipt .harness-evidence/corrective-probe.json):
 * exit 1, stdout empty, stderr exactly one line
 *   No MCP server named "<name>". Configured servers: alpha, beta-tools, <name>-old\n
 */
const CONFIGURED_SERVERS_PREFIX = `No MCP server named "${SERVER_NAME}". Configured servers: `;
/** Conservative server identifier; anything else is not safely understood. */
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Fail closed: "absent" only on exit 1 with stdout byte-empty and stderr either
 *  - exactly EMPTY_CONFIG_NOT_FOUND, or
 *  - exactly CONFIGURED_SERVERS_PREFIX followed by a non-empty ", "-separated
 *    list of distinct SERVER_ID names, none equal to SERVER_NAME, and a single
 *    terminal "\n" (no other line breaks, whitespace or control characters).
 * Stdout output, warnings, a bare or empty list, a list naming SERVER_NAME,
 * duplicates or unrecognized names are inconclusive (manual fallback is safer
 * than replacing a registration). Exit 0 is an existing registration in any
 * scope. Anything else may hide one.
 */
export function classifyProbe(p: ProbeResult): ProbeVerdict {
  if (p.error?.code === "ENOENT") return "cli_missing";
  if (p.error || p.signal !== null) return "inconclusive";
  if (p.status === 0) return "exists";
  if (p.status !== 1) return "inconclusive";
  const stdout = p.stdout ?? "";
  const stderr = p.stderr ?? "";
  if (stdout !== "") return "inconclusive";
  if (stderr === EMPTY_CONFIG_NOT_FOUND) return "absent";
  if (stderr.length > MAX_PROBE_TEXT) return "inconclusive";
  if (!stderr.startsWith(CONFIGURED_SERVERS_PREFIX) || !stderr.endsWith("\n")) return "inconclusive";
  const names = stderr.slice(CONFIGURED_SERVERS_PREFIX.length, -1).split(", ");
  if (!names.every((n) => SERVER_ID.test(n))) return "inconclusive";
  if (new Set(names).size !== names.length || names.includes(SERVER_NAME)) return "inconclusive";
  return "absent";
}
