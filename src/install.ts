// Pure planning logic for scripts/register.mjs (portable install). It only
// builds argv and classifies `claude mcp get` results; spawning stays in the
// script. ~/.claude.json is never read or written.

import path from "node:path";
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

export type RootChoice = { ok: true; path: string | null } | { ok: false; reason: string };

/** CODEX_IMAGE_OUTPUT_ROOT forwarded via `-e` to enable the image tool. Unset → null; set-but-invalid fails closed. */
export function resolveRegisteredOutputRoot(env: NodeJS.ProcessEnv): RootChoice {
  const raw = env.CODEX_IMAGE_OUTPUT_ROOT;
  if (raw === undefined || raw === "") return { ok: true, path: null };
  if (!absoluteNormalized(raw) || raw === "/") return { ok: false, reason: "CODEX_IMAGE_OUTPUT_ROOT must be an absolute normalized path other than /" };
  return { ok: true, path: raw };
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
 * Fail closed: "absent" only on exit 1 with exactly one non-empty stream that
 * starts with the exact not-found line observed from installed `claude` 2.1.293:
 *   No MCP server named "<name>". Configured servers: ...
 * The actual CLI writes it to stderr (stdout empty); stdout-only is also
 * accepted. Output on both streams is inconclusive. The configured-server list
 * is never stored; if it mentions the exact name again the answer is
 * contradictory and treated as inconclusive. Exit 0 is an existing
 * registration in any scope. Anything else may hide one.
 */
export function classifyProbe(p: ProbeResult): ProbeVerdict {
  if (p.error?.code === "ENOENT") return "cli_missing";
  if (p.error || p.signal !== null) return "inconclusive";
  if (p.status === 0) return "exists";
  if (p.status !== 1) return "inconclusive";
  const stdout = p.stdout ?? "";
  const stderr = p.stderr ?? "";
  const outEmpty = stdout.trim() === "";
  const errEmpty = stderr.trim() === "";
  if (outEmpty === errEmpty) return "inconclusive";
  const text = outEmpty ? stderr : stdout;
  if (text.length > MAX_PROBE_TEXT) return "inconclusive";
  const prefix = `No MCP server named "${SERVER_NAME}". Configured servers:`;
  if (!text.startsWith(prefix)) return "inconclusive";
  const exactName = new RegExp(`(^|[^\\w.-])${SERVER_NAME.replace(/[.-]/g, "\\$&")}($|[^\\w.-])`);
  return exactName.test(text.slice(prefix.length)) ? "inconclusive" : "absent";
}
