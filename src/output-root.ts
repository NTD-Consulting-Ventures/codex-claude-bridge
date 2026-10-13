// Shared image output-root resolver for the runtime server and the installer.
//
// Unset CODEX_IMAGE_OUTPUT_ROOT => ~/codex-images. An explicit value must be an
// absolute, normalized path other than "/"; anything else (including "") is a
// typed configuration error. There is never a fallback to the default and the
// image helper is never silently disabled. Error messages are fixed text and
// never echo the configured value.

import os from "node:os";
import path from "node:path";

export const OUTPUT_ROOT_ENV = "CODEX_IMAGE_OUTPUT_ROOT";
export const DEFAULT_OUTPUT_DIR = "codex-images";

export type OutputRootInvalidReason = "empty" | "nul_byte" | "relative" | "not_normalized" | "filesystem_root" | "home_unavailable";

export type OutputRootResolution =
  | { ok: true; path: string; source: "default" | "env" }
  | { ok: false; source: "default" | "env"; reason: OutputRootInvalidReason; message: string };

const REASON_TEXT: Record<Exclude<OutputRootInvalidReason, "home_unavailable">, string> = {
  empty: "is empty",
  nul_byte: "contains a NUL byte",
  relative: "is not absolute",
  not_normalized: "is not normalized",
  filesystem_root: "must not be /",
};

function invalid(reason: keyof typeof REASON_TEXT): OutputRootResolution {
  return {
    ok: false,
    source: "env",
    reason,
    message: `${OUTPUT_ROOT_ENV} ${REASON_TEXT[reason]}; unset it to use ~/${DEFAULT_OUTPUT_DIR} or set an absolute normalized path other than /.`,
  };
}

export function resolveOutputRoot(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): OutputRootResolution {
  const raw = env[OUTPUT_ROOT_ENV];
  if (raw === undefined) {
    let home: string;
    try {
      home = homedir();
    } catch {
      home = "";
    }
    // A broken home directory is reported as a configuration error, never guessed.
    if (typeof home !== "string" || home.includes("\0") || !path.isAbsolute(home) || path.normalize(home) === "/") {
      return { ok: false, source: "default", reason: "home_unavailable", message: `Home directory is unavailable; set ${OUTPUT_ROOT_ENV} to an absolute normalized path other than /.` };
    }
    return { ok: true, path: path.join(path.normalize(home), DEFAULT_OUTPUT_DIR), source: "default" };
  }
  if (raw === "") return invalid("empty");
  if (raw.includes("\0")) return invalid("nul_byte");
  if (!path.isAbsolute(raw)) return invalid("relative");
  if (raw === "/") return invalid("filesystem_root");
  if (path.normalize(raw) !== raw || raw.endsWith("/")) return invalid("not_normalized");
  return { ok: true, path: raw, source: "env" };
}
