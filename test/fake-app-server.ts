// Scripted in-process fake of the Codex app-server JSON-RPC peer (fixtures only).

import type { CodexTransport } from "../src/codex-client.js";

export type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

export interface Script {
  /** Return a reply for a client request; undefined = no reply. Use ctx.send for extra frames. */
  onRequest?: (msg: Msg, ctx: FakeAppServer) => unknown;
}

export const THREAD_ID = "thr_1";
export const TURN_ID = "turn_1";
export const DEFAULT_MODEL = "advertised-default";

/** A schema-shaped `model/list` Model entry (codex-cli 0.156.0 required fields). */
export function fakeModel(id: string, isDefault: boolean): object {
  return { id, model: id, displayName: id, description: "", hidden: false, isDefault, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] };
}

export class FakeAppServer implements CodexTransport {
  readonly received: Msg[] = [];
  killed = false;
  closed = false;
  private out: ((c: string) => void)[] = [];
  private exits: (() => void)[] = [];
  constructor(private readonly script: Script = {}) {}

  write(data: string): void {
    for (const line of data.split("\n").filter(Boolean)) {
      const msg = JSON.parse(line) as Msg;
      this.received.push(msg);
      if (msg.method && msg.id !== undefined) {
        const reply = this.script.onRequest ? this.script.onRequest(msg, this) : defaultReply(msg);
        if (reply !== undefined) queueMicrotask(() => this.send({ id: msg.id, ...(reply as object) }));
      }
    }
  }
  send(obj: object): void {
    const line = JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n";
    for (const cb of this.out) cb(line);
  }
  raw(s: string): void {
    for (const cb of this.out) cb(s);
  }
  exit(): void {
    for (const cb of this.exits) cb();
  }
  onStdout(cb: (c: string) => void): void {
    this.out.push(cb);
  }
  onStderr(): void {}
  onExit(cb: () => void): void {
    this.exits.push(cb);
  }
  kill(): void {
    this.killed = true;
  }
  close(): void {
    this.closed = true;
  }
  methods(): string[] {
    return this.received.filter((m) => m.method).map((m) => m.method as string);
  }
}

export function defaultReply(msg: Msg): unknown {
  switch (msg.method) {
    case "initialize":
      return { result: { userAgent: "fake" } };
    case "model/list":
      return { result: { data: [fakeModel("other-model", false), fakeModel(DEFAULT_MODEL, true)], nextCursor: null } };
    case "thread/start":
      return { result: { thread: { id: THREAD_ID } } };
    case "turn/start":
      return { result: { turn: { id: TURN_ID, items: [], status: "inProgress" } } };
    case "turn/interrupt":
      return { result: {} };
    default:
      return { error: { code: -32601, message: "method not found" } };
  }
}

export function agentMessage(text: string, id = "item_1"): object {
  return { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "agentMessage", id, text } } };
}

export function turnCompleted(status = "completed", error: unknown = null, turnId = TURN_ID): object {
  return { method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: turnId, items: [], status, error } } };
}

/** Script: complete the turn with the given frames right after turn/start replies. */
export function completingScript(frames: object[]): Script {
  return {
    onRequest(msg, ctx) {
      const r = defaultReply(msg);
      if (msg.method === "turn/start") setTimeout(() => frames.forEach((f) => ctx.send(f)), 1);
      return r;
    },
  };
}
