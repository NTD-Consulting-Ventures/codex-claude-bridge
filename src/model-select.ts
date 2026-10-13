// Per-thread runtime model selection from the live `model/list` catalog.
//
// The model inherited from the user's normal Codex config can be one the
// signed-in account cannot use (observed live: HTTP 400 "The '<model>' model is
// not supported when using Codex with a ChatGPT account."). Instead of editing
// config or guessing, each task asks the same app-server for its catalog and
// passes the single entry advertised with `isDefault: true` to the NEW
// thread's `thread/start.model`. Config, home, plugins and auth are untouched;
// the choice applies to that one thread only.
//
// There is no hard-coded id, no caller-supplied model and no fallback: a
// missing, duplicated or malformed default fails closed with MODEL_UNAVAILABLE.
// `model/list` is a read-only catalog call (ModelListParams, codex-cli 0.156.0:
// cursor/includeHidden/limit, all optional); only `cursor` is ever sent.

export const MAX_MODEL_PAGES = 5;
const MAX_MODELS = 500;
const MAX_CURSOR_CHARS = 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ModelSelectionFailure =
  | "invalid_shape"
  | "no_default"
  | "multiple_defaults"
  | "invalid_default_id"
  | "too_many_pages";

export type ModelSelection = { ok: true; model: string } | { ok: false; reason: ModelSelectionFailure };

/** ModelListParams: `{}` for the first page, `{ cursor }` for following pages. */
export function modelListParams(cursor?: string): Record<string, unknown> {
  return cursor === undefined ? {} : { cursor };
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Reads every `model/list` page (bounded) and returns the one advertised
 * default. `id` must be a plain identifier and equal `model`; anything else is
 * treated as invalid rather than interpreted. RPC errors propagate unchanged.
 */
export async function selectDefaultModel(request: (method: string, params: unknown) => Promise<unknown>): Promise<ModelSelection> {
  let cursor: string | undefined;
  let selected: string | undefined;
  let seen = 0;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const r = obj(await request("model/list", modelListParams(cursor)));
    if (!r || !Array.isArray(r.data)) return { ok: false, reason: "invalid_shape" };
    for (const m of r.data) {
      const o = obj(m);
      if (!o || typeof o.id !== "string" || typeof o.isDefault !== "boolean" || ++seen > MAX_MODELS) {
        return { ok: false, reason: "invalid_shape" };
      }
      if (!o.isDefault) continue;
      if (selected !== undefined) return { ok: false, reason: "multiple_defaults" };
      if (!MODEL_ID.test(o.id) || o.model !== o.id) return { ok: false, reason: "invalid_default_id" };
      selected = o.id;
    }
    const next = r.nextCursor;
    if (next === undefined || next === null) {
      return selected === undefined ? { ok: false, reason: "no_default" } : { ok: true, model: selected };
    }
    if (typeof next !== "string" || next.length === 0 || next.length > MAX_CURSOR_CHARS) {
      return { ok: false, reason: "invalid_shape" };
    }
    cursor = next;
  }
  return { ok: false, reason: "too_many_pages" };
}
