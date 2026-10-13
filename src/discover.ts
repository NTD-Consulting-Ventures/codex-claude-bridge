// Install-time executable discovery for scripts/register.mjs (never used at
// runtime). Deterministic order, no shell, aliases or interpolation:
//   1. explicit CODEX_BIN / CLAUDE_BIN: must be a valid executable file; a set
//      but unusable value (including empty) fails with NO fallback
//   2. absolute PATH directories in order (empty and relative entries ignored)
//   3. ~/.local/bin, /opt/homebrew/bin (darwin only), /usr/local/bin
//   4. `<npm prefix -g>/bin`, using an npm found by steps 2-3 or next to the
//      current Node; bounded, output validated. Never installs anything.
// Versions are checked with a bounded `--version` before anything is persisted.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { checkExecutable, EXEC_REASON_TEXT, isAbsoluteNormalized, launchEnv, VERSION_PROBE_BASE_ENV } from "./launch.js";
import { sanitizeVersion } from "./status.js";

export const NPM_TIMEOUT_MS = 15_000;
export const NPM_MAX_BUFFER = 64 * 1024;
export const VERSION_TIMEOUT_MS = 15_000;
export const VERSION_MAX_BUFFER = 4096;
const MAX_PREFIX_CHARS = 4096;

export interface RunResult {
  status: number | null;
  signal: string | null;
  error?: { code?: string } | undefined;
  stdout?: string | null;
  stderr?: string | null;
}

export type Runner = (file: string, args: string[], opts: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => RunResult;

export const spawnRunner: Runner = (file, args, o) => {
  const r = spawnSync(file, args, {
    shell: false,
    encoding: "utf8",
    timeout: o.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: o.maxBuffer,
    env: o.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { status: r.status, signal: r.signal, error: r.error as { code?: string } | undefined, stdout: r.stdout, stderr: r.stderr };
};

export interface DiscoverDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  execPath: string;
  run: Runner;
  /** Test seam: replaces wellKnownDirs(home, platform). */
  wellKnown?: string[];
}

const knownDirs = (d: DiscoverDeps): string[] => d.wellKnown ?? wellKnownDirs(d.home, d.platform);

export type DiscoverySource = "env" | "path" | "well_known" | "npm_prefix";
export type Discovery = { ok: true; path: string; source: DiscoverySource } | { ok: false; reason: string };

export function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(path.delimiter).filter((d) => d !== "" && !d.includes("\0") && path.isAbsolute(d));
}

export function wellKnownDirs(home: string, platform: NodeJS.Platform): string[] {
  const dirs = isAbsoluteNormalized(home) ? [path.join(home, ".local", "bin")] : [];
  if (platform === "darwin") dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");
  return dirs;
}

function firstExecutable(dirs: string[], name: string): string | null {
  for (const d of dirs) {
    const c = checkExecutable(path.join(d, name));
    if (c.ok) return c.path;
  }
  return null;
}

/** Fail-closed reason for any failed bounded subprocess; null when it exited 0 cleanly. */
export function runFailure(r: RunResult): string | null {
  if (r.error) return `error ${r.error.code ?? "unknown"}`;
  if (r.signal !== null) return `killed by ${r.signal}`;
  if (r.status !== 0) return `exit status ${String(r.status)}`;
  return null;
}

/** `npm prefix -g` output: exactly one absolute normalized line (one trailing newline allowed). */
export function parseNpmPrefix(stdout: string | null | undefined): string | null {
  if (typeof stdout !== "string") return null;
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (line.length === 0 || line.length > MAX_PREFIX_CHARS || /[\r\n]/.test(line)) return null;
  return isAbsoluteNormalized(line) ? line : null;
}

export type NpmBin = { ok: true; npm: string; dir: string } | { ok: false; reason: string };

export function npmGlobalBin(deps: DiscoverDeps): NpmBin {
  const npm = firstExecutable([...pathDirs(deps.env), ...knownDirs(deps), path.dirname(deps.execPath)], "npm");
  if (npm === null) return { ok: false, reason: "npm not found" };
  const env = { ...launchEnv(deps.env, deps.execPath), npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1" };
  const r = deps.run(npm, ["prefix", "-g"], { timeoutMs: NPM_TIMEOUT_MS, maxBuffer: NPM_MAX_BUFFER, env });
  const failed = runFailure(r);
  if (failed !== null) return { ok: false, reason: `\`${npm} prefix -g\` failed (${failed})` };
  const prefix = parseNpmPrefix(r.stdout);
  if (prefix === null) return { ok: false, reason: `\`${npm} prefix -g\` printed no single absolute normalized path` };
  return { ok: true, npm, dir: path.join(prefix, "bin") };
}

export function discoverExecutable(name: "codex" | "claude", envVar: "CODEX_BIN" | "CLAUDE_BIN", deps: DiscoverDeps): Discovery {
  const raw = deps.env[envVar];
  if (raw !== undefined) {
    const c = checkExecutable(raw);
    if (c.ok) return { ok: true, path: c.path, source: "env" };
    return { ok: false, reason: `${envVar} is set but ${EXEC_REASON_TEXT[c.reason]}; not falling back to discovery` };
  }
  const onPath = firstExecutable(pathDirs(deps.env), name);
  if (onPath !== null) return { ok: true, path: onPath, source: "path" };
  const known = firstExecutable(knownDirs(deps), name);
  if (known !== null) return { ok: true, path: known, source: "well_known" };
  const npm = npmGlobalBin(deps);
  if (npm.ok) {
    const viaNpm = firstExecutable([npm.dir], name);
    if (viaNpm !== null) return { ok: true, path: viaNpm, source: "npm_prefix" };
  }
  const searched = [...knownDirs(deps), npm.ok ? npm.dir : `npm global prefix (${npm.reason})`].join(", ");
  return { ok: false, reason: `no executable \`${name}\` found on PATH or in ${searched}` };
}

export type VersionCheck = { ok: true; version: string } | { ok: false; reason: string };

const CLAUDE_VERSION = /^(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?) \(Claude Code\)$/;

/** Bounded `codex --version` with the same environment as the runtime status probe. */
export function checkCodexVersion(bin: string, deps: DiscoverDeps): VersionCheck {
  const r = deps.run(bin, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER, env: launchEnv(VERSION_PROBE_BASE_ENV, deps.execPath) });
  const failed = runFailure(r);
  if (failed !== null) return { ok: false, reason: `\`codex --version\` failed (${failed})` };
  const v = sanitizeVersion(r.stdout ?? "");
  return v === null ? { ok: false, reason: "`codex --version` printed an unexpected version line" } : { ok: true, version: v };
}

/** Bounded `claude --version`; the Claude CLI keeps the user's environment (plus the launch PATH). */
export function checkClaudeVersion(bin: string, deps: DiscoverDeps): VersionCheck {
  const r = deps.run(bin, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER, env: launchEnv(deps.env, deps.execPath) });
  const failed = runFailure(r);
  if (failed !== null) return { ok: false, reason: `\`claude --version\` failed (${failed})` };
  const m = CLAUDE_VERSION.exec((r.stdout ?? "").trim());
  return m?.[1] ? { ok: true, version: m[1] } : { ok: false, reason: "`claude --version` printed an unexpected version line" };
}

/** Official install / sign-in guidance printed when a prerequisite is missing. Nothing is run for the user. */
export const INSTALL_GUIDANCE = {
  node: "Install Node.js 22 or newer from https://nodejs.org/en/download, then re-run.",
  codex:
    "Install the official Codex CLI (https://github.com/openai/codex): `npm install -g @openai/codex` " +
    "or `brew install --cask codex`, then sign in with `codex login`. Or set CODEX_BIN to its absolute path.",
  claude:
    "Install Claude Code (https://docs.anthropic.com/en/docs/claude-code/setup): " +
    "`curl -fsSL https://claude.ai/install.sh | bash` or `npm install -g @anthropic-ai/claude-code`, " +
    "then sign in with `claude auth login`. Or set CLAUDE_BIN to its absolute path.",
} as const;
