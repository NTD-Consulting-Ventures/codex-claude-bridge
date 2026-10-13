// Live transport: the installed official Codex CLI in app-server mode over stdio.
//
// Launched with exactly `app-server --listen stdio://`. No --config overrides,
// no bypass/dangerous flags, no shell. The inherited environment is kept so
// the user's normal Codex home, config and login are used unchanged; this
// process never reads them itself. Only PATH is adjusted (src/launch.ts) so an
// npm `#!/usr/bin/env node` Codex launcher finds the verified current Node.
//
// Process ownership: on POSIX the child is spawned `detached`, i.e. as the
// leader of a NEW process group whose id equals its pid. Everything Codex
// starts (plugins, MCP servers, tools) inherits that group unless it creates
// its own session. Termination signals the whole owned group (`kill(-pgid)`),
// never any pre-existing process of the user. Caveat: a descendant that calls
// setsid()/setpgid() leaves the group and is not reached; and the parent being
// SIGKILLed cannot run any cleanup (app-server then sees stdin EOF).

import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { CodexTransport } from "./codex-client.js";
import { isAbsoluteNormalized, launchEnv } from "./launch.js";

export const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
export const KILL_GRACE_MS = 2_000;
const GROUP_POLL_MS = 50;

export interface CodexBin {
  /** Absolute normalized path, or null when CODEX_BIN is set but unusable. */
  path: string | null;
  source: "env" | "default";
}

/** Official default install location of the Codex CLI for the current user. */
export function defaultCodexBin(): string {
  return path.join(os.homedir(), ".local", "bin", "codex");
}

/**
 * CODEX_BIN (absolute, normalized) overrides the default `~/.local/bin/codex`.
 * A set-but-invalid CODEX_BIN, including an empty one, fails closed (path
 * null); it never falls back. No PATH or npm discovery at runtime: the
 * installer persists the discovered absolute path as CODEX_BIN.
 */
export function resolveCodexBin(env: NodeJS.ProcessEnv = process.env): CodexBin {
  const raw = env.CODEX_BIN;
  if (raw === undefined) return { path: defaultCodexBin(), source: "default" };
  if (!isAbsoluteNormalized(raw)) return { path: null, source: "env" };
  return { path: raw, source: "env" };
}

export interface SpawnOptions {
  bin: string;
  /** Explicit absolute working directory of the app-server process. */
  cwd: string;
  /** Environment before the shared launch PATH adjustment (default process.env). */
  baseEnv?: NodeJS.ProcessEnv;
}

interface LiveGroup {
  terminate(): Promise<void>;
}

const live = new Set<LiveGroup>();

/** Number of app-server process groups this process still owns (diagnostics/tests). */
export function liveAppServerCount(): number {
  return live.size;
}

/** Terminates every owned app-server process group; resolves when all are gone or SIGKILLed. */
export async function terminateAllAppServers(): Promise<void> {
  await Promise.all([...live].map((g) => g.terminate()));
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    // EPERM means a process with that group exists but is not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function spawnAppServer(opts: SpawnOptions): CodexTransport {
  if (!path.isAbsolute(opts.bin) || !path.isAbsolute(opts.cwd)) throw new Error("absolute bin and cwd required");
  const useGroup = process.platform !== "win32";
  const child: ChildProcess = spawn(opts.bin, [...APP_SERVER_ARGS], {
    cwd: opts.cwd,
    shell: false,
    detached: useGroup,
    stdio: ["pipe", "pipe", "pipe"],
    env: launchEnv(opts.baseEnv ?? process.env),
    windowsHide: true,
  });
  const pgid = useGroup && typeof child.pid === "number" ? child.pid : undefined;
  let exited = false;
  const exitCbs: (() => void)[] = [];
  const fireExit = (): void => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb();
  };
  child.on("exit", fireExit);
  child.on("error", fireExit);
  child.stdin?.on("error", () => undefined);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (pgid !== undefined) process.kill(-pgid, sig);
      else if (!exited) child.kill(sig);
    } catch {
      // ESRCH: already gone.
    }
  };
  const gone = (): boolean => (pgid !== undefined ? !groupAlive(pgid) : exited);

  let termination: Promise<void> | undefined;
  const group: LiveGroup = {
    terminate() {
      termination ??= new Promise<void>((resolve) => {
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        // Signal the group even if the leader already exited: plugin/MCP
        // children may outlive it.
        signal("SIGTERM");
        const started = Date.now();
        const tick = (): void => {
          if (gone()) return finish();
          if (Date.now() - started >= KILL_GRACE_MS) {
            signal("SIGKILL");
            return finish();
          }
          setTimeout(tick, GROUP_POLL_MS);
        };
        const finish = (): void => {
          live.delete(group);
          resolve();
        };
        tick();
      });
      return termination;
    },
  };
  live.add(group);
  // Reap leftover group members as soon as the leader exits, so the pgid is
  // never signalled long after it could have been recycled.
  child.on("exit", () => void group.terminate());
  // A spawn failure (ENOENT etc.) has no group to own.
  child.on("error", () => {
    if (pgid === undefined) live.delete(group);
  });

  const terminate = (): void => {
    void group.terminate();
  };

  return {
    write(data) {
      if (exited || !child.stdin) throw new Error("closed");
      child.stdin.write(data);
    },
    onStdout(cb) {
      child.stdout?.on("data", cb);
    },
    onStderr(cb) {
      child.stderr?.on("data", cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    kill: terminate,
    close: terminate,
  };
}
