import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import { CodexClientError, CodexRpcClient, type CodexTransport } from "./codex-client.js";
import { resolveCodexBin, spawnAppServer } from "./process-transport.js";
import { APPROVAL_POLICY, initializeParams, SANDBOX_MODE } from "./session.js";

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BYTES = 4096;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_LISTED = 100;
const MCP_PAGE_LIMIT = 50;
const MAX_MCP_PAGES = 4;
const MAX_CURSOR_CHARS = 1024;
export const SERVER_VERSION = "0.1.0";

export interface VersionProbeResult {
  ok: boolean;
  stdout: string;
}

export type VersionProbe = () => Promise<VersionProbeResult>;

/** Bounded spawn of `codex --version`: no shell, minimal env, timeout, output cap. */
export const probeCodexVersion: VersionProbe = () =>
  new Promise((resolve) => {
    let out = "";
    let bytes = 0;
    let done = false;
    const finish = (r: VersionProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const bin = resolveCodexBin().path;
    if (bin === null) {
      resolve({ ok: false, stdout: "" });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin" },
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout: "" });
    }, VERSION_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      bytes += Buffer.byteLength(c, "utf8");
      if (bytes > VERSION_MAX_BYTES) {
        child.kill("SIGKILL");
        finish({ ok: false, stdout: "" });
        return;
      }
      out += c;
    });
    child.on("error", () => finish({ ok: false, stdout: "" }));
    child.on("close", (code) => finish({ ok: code === 0, stdout: out }));
  });

export function sanitizeVersion(stdout: string): string | null {
  const m = /^codex-cli (\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?)\s*$/.exec(stdout.trim());
  return m?.[1] ?? null;
}

/** Sanitized installed Codex CLI version, or null when it cannot be determined. */
export async function codexVersion(probe: VersionProbe = probeCodexVersion): Promise<string | null> {
  try {
    const r = await probe();
    return r.ok ? sanitizeVersion(r.stdout) : null;
  } catch {
    return null;
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}$/;
const SAFE_ENUM = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

function safeName(v: unknown): string | null {
  return typeof v === "string" && SAFE_NAME.test(v) && !v.includes("://") ? v : null;
}
function safeEnum(v: unknown): string | null {
  return typeof v === "string" && SAFE_ENUM.test(v) ? v : null;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface Listing<T> {
  available: boolean;
  reason: string | null;
  items: T[];
  /** True when entries were dropped because a local bound (items or pages) was hit. */
  truncated: boolean;
  /** Peer still advertised a next page when paging stopped; null when unknown. */
  has_more: boolean | null;
}

export interface PluginSummary {
  name: string;
  enabled: boolean;
  installed: boolean;
}

export interface McpServerSummary {
  name: string;
  auth_status: string | null;
}

/** Keeps only verified names and booleans. URLs, paths, ids and account data are dropped. */
export function summarizePlugins(result: unknown): PluginSummary[] {
  return pluginListing(result).items;
}

function pluginListing(result: unknown): Listing<PluginSummary> {
  const out: PluginSummary[] = [];
  let truncated = false;
  const markets = obj(result)?.marketplaces;
  if (!Array.isArray(markets)) throw new Error("shape");
  for (const m of markets) {
    const plugins = obj(m)?.plugins;
    if (!Array.isArray(plugins)) continue;
    for (const p of plugins) {
      const o = obj(p);
      const name = safeName(o?.name);
      if (!o || name === null) continue;
      if (out.length >= MAX_LISTED) {
        truncated = true;
        continue;
      }
      out.push({ name, enabled: o.enabled === true, installed: o.installed === true });
    }
  }
  // plugin/installed is not paginated.
  return { available: true, reason: null, items: out, truncated, has_more: false };
}

export function summarizeMcpServers(result: unknown): McpServerSummary[] {
  const out: McpServerSummary[] = [];
  appendMcpPage(result, out);
  return out;
}

/** Appends one page; returns its validated nextCursor (null = last page) and whether items were capped. */
function appendMcpPage(result: unknown, out: McpServerSummary[]): { next: string | null; capped: boolean } {
  const r = obj(result);
  const data = r?.data;
  if (!Array.isArray(data)) throw new Error("shape");
  let capped = false;
  for (const s of data) {
    const o = obj(s);
    const name = safeName(o?.name);
    if (!o || name === null) continue;
    if (out.length >= MAX_LISTED) {
      capped = true;
      continue;
    }
    out.push({ name, auth_status: safeEnum(o.authStatus) });
  }
  const next = r?.nextCursor;
  if (next === undefined || next === null) return { next: null, capped };
  if (typeof next !== "string" || next.length === 0 || next.length > MAX_CURSOR_CHARS) throw new Error("shape");
  return { next, capped };
}

/**
 * ListMcpServerStatusParams (codex-cli 0.156.0 schema): `detail: "toolsAndAuthOnly"`
 * is the smaller of the two McpServerStatusDetail variants (the default `full`
 * also fetches resources); `limit` bounds each page. Paging stops after
 * MAX_MCP_PAGES and reports has_more honestly.
 */
export function mcpStatusListParams(cursor: string | null): Record<string, unknown> {
  const p: Record<string, unknown> = { detail: "toolsAndAuthOnly", limit: MCP_PAGE_LIMIT };
  if (cursor !== null) p.cursor = cursor;
  return p;
}

async function listMcpServers(client: CodexRpcClient): Promise<Listing<McpServerSummary>> {
  const items: McpServerSummary[] = [];
  let cursor: string | null = null;
  let truncated = false;
  for (let page = 0; page < MAX_MCP_PAGES; page++) {
    const r = appendMcpPage(await client.request("mcpServerStatus/list", mcpStatusListParams(cursor), { timeoutMs: PROBE_TIMEOUT_MS }), items);
    truncated ||= r.capped;
    cursor = r.next;
    if (cursor === null) return { available: true, reason: null, items, truncated, has_more: false };
    if (truncated) break;
  }
  return { available: true, reason: null, items, truncated: true, has_more: true };
}

export interface CapabilityProbeResult {
  plugins: Listing<PluginSummary>;
  mcp_servers: Listing<McpServerSummary>;
}

export type CapabilityProbe = () => Promise<CapabilityProbeResult>;

const unknownListing = <T>(reason: string): Listing<T> => ({ available: false, reason, items: [], truncated: false, has_more: null });

/**
 * Listing failure reason built only from fixed enums (CodexErrorKind, RpcErrorClass,
 * RpcMessageClass, schema identifier): e.g. "mcpServerStatus/list failed:
 * rpc invalid_request/experimental_api_required". Peer text is never included.
 */
export function listingFailureReason(method: string, e: unknown): string {
  if (!(e instanceof CodexClientError)) return `${method} failed: invalid_response_shape`;
  if (!e.rpc) return `${method} failed: ${e.kind}`;
  const field = e.rpc.field !== undefined ? ` field=${e.rpc.field}` : "";
  return `${method} failed: rpc ${e.rpc.rpc_class}/${e.rpc.message_class}${field}`;
}

/**
 * Neutral explicit cwd for the status probe (no task cwd exists here): the
 * resolved system temp directory, so no project-local Codex config is picked up.
 */
function probeCwd(): string {
  return realpathSync(os.tmpdir());
}

function defaultProbeTransport(): CodexTransport {
  const bin = resolveCodexBin().path;
  if (bin === null) throw new Error("CODEX_BIN invalid");
  return spawnAppServer({ bin, cwd: probeCwd() });
}

/** Read-only listing via plugin/installed and mcpServerStatus/list. No thread or turn is started. */
export async function probeCapabilities(
  createTransport: () => CodexTransport = defaultProbeTransport,
): Promise<CapabilityProbeResult> {
  let client: CodexRpcClient;
  try {
    client = new CodexRpcClient(createTransport());
  } catch {
    return { plugins: unknownListing("app-server unavailable"), mcp_servers: unknownListing("app-server unavailable") };
  }
  try {
    try {
      await client.request("initialize", initializeParams(SERVER_VERSION), { timeoutMs: PROBE_TIMEOUT_MS });
      client.notify("initialized");
    } catch {
      return { plugins: unknownListing("initialize failed"), mcp_servers: unknownListing("initialize failed") };
    }
    let plugins: Listing<PluginSummary>;
    try {
      plugins = pluginListing(await client.request("plugin/installed", {}, { timeoutMs: PROBE_TIMEOUT_MS }));
    } catch (e) {
      plugins = unknownListing(listingFailureReason("plugin/installed", e));
    }
    let mcp: Listing<McpServerSummary>;
    try {
      mcp = await listMcpServers(client);
    } catch (e) {
      mcp = unknownListing(listingFailureReason("mcpServerStatus/list", e));
    }
    return { plugins, mcp_servers: mcp };
  } finally {
    client.kill("closed");
  }
}

export interface CodexStatus {
  server: "codex-image-mcp";
  server_version: string;
  mode: "trusted-local-delegation";
  codex_cli_version: string | null;
  codex_cli_available: boolean;
  launch: { approval_policy: string; sandbox: string; experimental_api: false };
  plugins: Listing<PluginSummary>;
  mcp_servers: Listing<McpServerSummary>;
  image_generate_enabled: boolean;
  image_edit_enabled: false;
  note: string;
}

export async function getStatus(
  probe: VersionProbe = probeCodexVersion,
  capabilities: CapabilityProbe = probeCapabilities,
  imageEnabled = false,
): Promise<CodexStatus> {
  const version = await codexVersion(probe);
  let caps: CapabilityProbeResult;
  if (version === null) {
    caps = { plugins: unknownListing("codex CLI unavailable"), mcp_servers: unknownListing("codex CLI unavailable") };
  } else {
    try {
      caps = await capabilities();
    } catch {
      caps = { plugins: unknownListing("probe failed"), mcp_servers: unknownListing("probe failed") };
    }
  }
  return {
    server: "codex-image-mcp",
    server_version: SERVER_VERSION,
    mode: "trusted-local-delegation",
    codex_cli_version: version,
    codex_cli_available: version !== null,
    launch: { approval_policy: APPROVAL_POLICY, sandbox: SANDBOX_MODE, experimental_api: false },
    plugins: caps.plugins,
    mcp_servers: caps.mcp_servers,
    image_generate_enabled: imageEnabled,
    image_edit_enabled: false,
    note:
      "Trusted-local capability, not a security boundary: delegated prompts run as a general Codex agent " +
      "with the user's normal Codex config, plugins and MCP servers, under native read-only sandbox and " +
      "on-request approvals. Approval requests are denied and fail the job with APPROVAL_REQUIRED.",
  };
}
