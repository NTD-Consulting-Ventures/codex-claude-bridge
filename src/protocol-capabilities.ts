// Runtime discovery of the image-session protocol features the installed
// official Codex app-server actually supports.
//
// The configured launcher is asked for its own stable JSON schema
// (`codex app-server generate-json-schema --out <dir>`; never `--experimental`):
// no shell, no model turn, an owned private temp dir that is always removed,
// a timeout, and bounds on output, file count and bytes. Methods are taken from
// the generated ClientRequest union (each variant's `method`), and parameter
// fields from that variant's `params` schema, never from file names alone.
// There is no CLI version allowlist and no assumed field: whatever cannot be
// proven from the schema is reported unsupported, and continuity then fails
// closed (new-thread image generation keeps working). A typed field must
// declare a compatible type; an untyped or differently typed one is not
// support. On timeout or output overflow only the generator's own process
// group is killed, and it is reaped before the temp dir is removed. An
// abort signal (server shutdown) does the same; a cancelled discovery reports
// "discovery_cancelled" and must never be used to start a generation.

import { spawn } from "node:child_process";
import { promises as fsp, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchEnv } from "./launch.js";

export const SCHEMA_ARGS = ["app-server", "generate-json-schema", "--out"] as const;
const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_SCHEMA_FILES = 2_000;
const MAX_SCHEMA_DIRS = 256;
/** Bound on waiting for a killed generator's stdio to close once it has exited. */
const REAP_GRACE_MS = 2_000;
const MAX_SCHEMA_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SCHEMA_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REF_DEPTH = 8;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Why continuity (or native instructions) is unavailable. Fixed enums only. */
export type CapabilityReason =
  | "injected_transport"
  | "launcher_invalid"
  | "discovery_failed"
  | "discovery_cancelled"
  | "schema_invalid"
  | "no_thread_start_instructions"
  | "no_thread_resume"
  | "resume_params_missing"
  | "turn_params_missing";

export interface ImageProtocolCapabilities {
  /** thread/start accepts `developerInstructions` (string). */
  nativeInstructions: boolean;
  /** Bridge-owned thread continuation via thread/resume + turn/start is provable from the schema. */
  continuity: boolean;
  /** ThreadResumeParams.excludeTurns (boolean) exists: the resume response then carries no history. */
  resumeExcludeTurns: boolean;
  /** thread/name/set with threadId (string) and name (string) exists. */
  setName: boolean;
  /** Null when continuity is available. */
  reason: CapabilityReason | null;
}

export const unavailable = (reason: CapabilityReason): ImageProtocolCapabilities => ({
  nativeInstructions: false,
  continuity: false,
  resumeExcludeTurns: false,
  setName: false,
  reason,
});

/** Property name -> declared JSON types (empty when the schema gives none). */
export type ParamProps = Map<string, Set<string>>;
/** Method name -> its params properties (null when the params schema could not be resolved). */
export type MethodTable = Map<string, ParamProps | null>;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function resolveRef(doc: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const seg of ref.slice(2).split("/")) {
    const o = obj(cur);
    if (!o || !Object.hasOwn(o, seg)) return undefined;
    cur = o[seg];
  }
  return obj(cur);
}

function types(schema: Record<string, unknown>, doc: Record<string, unknown>, depth = 0): Set<string> {
  const out = new Set<string>();
  if (depth > MAX_REF_DEPTH) return out;
  const t = schema.type;
  if (typeof t === "string") out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
  if (typeof schema.$ref === "string") {
    const r = resolveRef(doc, schema.$ref);
    if (r) for (const x of types(r, doc, depth + 1)) out.add(x);
  }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    const alts = schema[k];
    if (Array.isArray(alts)) for (const a of alts) if (obj(a)) for (const x of types(obj(a)!, doc, depth + 1)) out.add(x);
  }
  return out;
}

/** Properties of an object schema, following $ref / nullable anyOf / allOf (bounded). */
function objectProps(schema: Record<string, unknown> | undefined, doc: Record<string, unknown>, depth = 0): ParamProps | null {
  if (!schema || depth > MAX_REF_DEPTH) return null;
  if (typeof schema.$ref === "string") return objectProps(resolveRef(doc, schema.$ref), doc, depth + 1);
  const props = obj(schema.properties);
  if (props) {
    const out: ParamProps = new Map();
    for (const [k, v] of Object.entries(props)) out.set(k, obj(v) ? types(obj(v)!, doc) : new Set());
    return out;
  }
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    const alts = schema[k];
    if (!Array.isArray(alts)) continue;
    let merged: ParamProps | null = null;
    for (const a of alts) {
      const p = objectProps(obj(a), doc, depth + 1);
      if (!p) continue;
      merged ??= new Map();
      for (const [n, t] of p) merged.set(n, t);
    }
    if (merged) return merged;
  }
  return null;
}

function refName(schema: Record<string, unknown> | undefined): string | null {
  const ref = schema?.$ref;
  if (typeof ref !== "string") return null;
  const last = ref.split("/").pop() ?? "";
  return IDENT.test(last) ? last : null;
}

/**
 * Builds the method table from a parsed ClientRequest schema. `loadNamed`
 * resolves a params type by name from its own generated file when the union
 * only references it externally.
 */
export async function methodsFromClientRequest(
  doc: unknown,
  loadNamed: (name: string) => Promise<Record<string, unknown> | null> = async () => null,
): Promise<MethodTable> {
  const root = obj(doc);
  const variants = root ? (root.oneOf ?? root.anyOf) : undefined;
  if (!root || !Array.isArray(variants)) throw new Error("schema_invalid");
  const table: MethodTable = new Map();
  for (const v of variants) {
    const props = obj(obj(v)?.properties);
    const m = obj(props?.method);
    const en = m?.enum;
    const method = typeof m?.const === "string" ? m.const : Array.isArray(en) && en.length === 1 && typeof en[0] === "string" ? en[0] : null;
    if (method === null || table.has(method)) continue;
    const paramsSchema = obj(props?.params);
    let params = objectProps(paramsSchema, root);
    if (params === null) {
      const name = refName(paramsSchema) ?? refName(obj((paramsSchema?.anyOf as unknown[] | undefined)?.find((x) => refName(obj(x)) !== null)));
      const ext = name !== null ? await loadNamed(name) : null;
      if (ext) params = objectProps(ext, ext);
    }
    table.set(method, params);
  }
  return table;
}

/** Stable method name of thread renaming (ClientRequest method enum; params ThreadSetNameParams). */
export const THREAD_NAME_SET = "thread/name/set";

/** Typed lookups fail closed: the property must declare that type (untyped or other types do not count). */
const has = (p: ParamProps | null | undefined, name: string, type?: string): boolean => {
  const t = p?.get(name);
  return t !== undefined && (type === undefined || t.has(type));
};

/** Derives the image capabilities from a method table. */
export function capabilitiesFromMethods(table: MethodTable): ImageProtocolCapabilities {
  const start = table.get("thread/start");
  const resume = table.get("thread/resume");
  const turn = table.get("turn/start");
  const setName = table.get(THREAD_NAME_SET);
  const nativeInstructions = has(start, "developerInstructions", "string");
  const caps: ImageProtocolCapabilities = {
    nativeInstructions,
    continuity: false,
    resumeExcludeTurns: has(resume, "excludeTurns", "boolean"),
    setName: has(setName, "threadId", "string") && has(setName, "name", "string"),
    reason: null,
  };
  if (!nativeInstructions) caps.reason = "no_thread_start_instructions";
  else if (!table.has("thread/resume")) caps.reason = "no_thread_resume";
  else if (
    !["threadId", "cwd", "model", "approvalPolicy", "approvalsReviewer", "sandbox"].every((k) => has(resume, k)) ||
    !has(resume, "developerInstructions", "string")
  ) {
    caps.reason = "resume_params_missing";
  } else if (!["threadId", "input", "cwd", "approvalPolicy", "approvalsReviewer", "sandboxPolicy"].every((k) => has(turn, k))) {
    caps.reason = "turn_params_missing";
  } else caps.continuity = true;
  return caps;
}

/** Reads one generated schema file: regular file (no symlink), bounded size, JSON object. */
async function readSchemaFile(file: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile() || st.size > MAX_SCHEMA_FILE_BYTES) return null;
    return obj(JSON.parse(await fsp.readFile(file, "utf8"))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Bounds the generated tree: directory and file counts (entries are streamed,
 * so an exploding directory is never listed in full), total bytes, and no
 * symlinks (never followed).
 */
async function checkTree(dir: string): Promise<boolean> {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for await (const e of await fsp.opendir(d)) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) {
        if (++dirs > MAX_SCHEMA_DIRS) return false;
        stack.push(p);
        continue;
      }
      if (++files > MAX_SCHEMA_FILES) return false;
      bytes += (await fsp.lstat(p)).size;
      if (bytes > MAX_SCHEMA_TOTAL_BYTES) return false;
    }
  }
  return true;
}

/** Parses a generated schema directory into capabilities. */
export async function capabilitiesFromSchemaDir(dir: string): Promise<ImageProtocolCapabilities> {
  if (!(await checkTree(dir))) return unavailable("schema_invalid");
  const doc = await readSchemaFile(path.join(dir, "ClientRequest.json"));
  if (!doc) return unavailable("schema_invalid");
  const loadNamed = async (name: string): Promise<Record<string, unknown> | null> =>
    (await readSchemaFile(path.join(dir, "v2", `${name}.json`))) ?? (await readSchemaFile(path.join(dir, `${name}.json`)));
  try {
    return capabilitiesFromMethods(await methodsFromClientRequest(doc, loadNamed));
  } catch {
    return unavailable("schema_invalid");
  }
}

/**
 * Runs the generator in its own process group (POSIX) and resolves only once
 * it has exited and been reaped and its stdio has closed, so nothing it
 * started can still be writing when the caller removes the temp dir. Timeout
 * and output overflow kill that group (never any other process) and then wait
 * for the same exit; a descendant that left the group and still holds stdio
 * is waited for at most REAP_GRACE_MS after the exit.
 */
function runSchemaGenerator(bin: string, out: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const group = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...SCHEMA_ARGS, out], {
        cwd: out,
        shell: false,
        detached: group,
        stdio: ["ignore", "pipe", "pipe"],
        env: launchEnv(env),
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    let aborted = false;
    let bytes = 0;
    let grace: NodeJS.Timeout | undefined;
    const settle = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", abort);
      resolve(ok);
    };
    // The group id is the child's own pid (detached), so only its process group is signalled.
    const killGroup = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      killGroup();
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    // Output is counted, never parsed or kept.
    const count = (c: Buffer): void => {
      bytes += c.length;
      if (bytes > MAX_PROCESS_OUTPUT_BYTES) abort();
    };
    child.stdout?.on("data", count);
    child.stderr?.on("data", count);
    child.on("error", () => {
      // No pid: the process never started, so there is nothing to wait for.
      if (child.pid === undefined) settle(false);
      else abort();
    });
    child.on("exit", () => {
      // Leftover group members (for example a backgrounded helper) are killed too.
      killGroup();
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(false);
      }, REAP_GRACE_MS);
    });
    child.on("close", (code) => settle(!aborted && code === 0));
  });
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Parent of the owned temp dir (default: the resolved system temp dir). */
  tmpRoot?: string;
  /** Aborting kills and reaps the generator's own group (no spawn when already aborted). */
  signal?: AbortSignal;
}

/**
 * Asks the configured launcher for its stable schema in an owned private temp
 * dir (mode 0700, removed afterwards) and derives the capabilities. Any
 * failure fails closed to "unavailable".
 */
export async function discoverImageCapabilities(bin: string | null, opts: DiscoveryOptions = {}): Promise<ImageProtocolCapabilities> {
  if (bin === null || !path.isAbsolute(bin)) return unavailable("launcher_invalid");
  const signal = opts.signal;
  if (signal?.aborted) return unavailable("discovery_cancelled");
  let dir: string;
  try {
    dir = await fsp.mkdtemp(path.join(opts.tmpRoot ?? realpathSync(os.tmpdir()), "codex-bridge-schema-"));
  } catch {
    return unavailable("discovery_failed");
  }
  try {
    const out = path.join(dir, "schema");
    await fsp.mkdir(out, { mode: 0o700 });
    const ran = await runSchemaGenerator(bin, out, opts.env ?? process.env, opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS, signal);
    if (signal?.aborted) return unavailable("discovery_cancelled");
    if (!ran) return unavailable("discovery_failed");
    const caps = await capabilitiesFromSchemaDir(out);
    return signal?.aborted ? unavailable("discovery_cancelled") : caps;
  } catch {
    return unavailable(signal?.aborted ? "discovery_cancelled" : "discovery_failed");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
