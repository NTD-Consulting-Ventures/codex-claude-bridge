// Bridge mode: which MCP tools this server exposes. One resolver shared by the
// server (src/server.ts) and the installer (src/install.ts, scripts/register.mjs).
//
// CODEX_BRIDGE_MODE unset → "general" (all tools, unchanged behaviour). Set, it
// must be exactly "general" or "image-only"; anything else (including empty or
// whitespace) fails closed with a static diagnostic that never echoes the value.
// The mode only narrows the MCP tool surface; it does not change how Codex is
// launched and is not a sandbox (docs/image-only.md).

export const BRIDGE_MODE_ENV = "CODEX_BRIDGE_MODE";
export const BRIDGE_MODES = ["general", "image-only"] as const;
export type BridgeMode = (typeof BRIDGE_MODES)[number];

export const BRIDGE_MODE_INVALID_MESSAGE = `${BRIDGE_MODE_ENV} must be exactly "general" or "image-only" when set (value not shown)`;

export type BridgeModeResolution =
  | { ok: true; mode: BridgeMode; source: "default" | "env" }
  | { ok: false; message: string };

export function isBridgeMode(v: unknown): v is BridgeMode {
  return typeof v === "string" && (BRIDGE_MODES as readonly string[]).includes(v);
}

export function resolveBridgeMode(env: NodeJS.ProcessEnv = process.env): BridgeModeResolution {
  const raw = env[BRIDGE_MODE_ENV];
  if (raw === undefined) return { ok: true, mode: "general", source: "default" };
  return isBridgeMode(raw) ? { ok: true, mode: raw, source: "env" } : { ok: false, message: BRIDGE_MODE_INVALID_MESSAGE };
}

export class BridgeModeError extends Error {
  constructor() {
    super(BRIDGE_MODE_INVALID_MESSAGE);
    this.name = "BridgeModeError";
  }
}

/** Resolved mode, or throws BridgeModeError (static message) when CODEX_BRIDGE_MODE is invalid. */
export function requireBridgeMode(env: NodeJS.ProcessEnv = process.env): BridgeMode {
  const r = resolveBridgeMode(env);
  if (!r.ok) throw new BridgeModeError();
  return r.mode;
}
