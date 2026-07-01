// Shared e2e harness — the deterministic fake-provider fixtures, the worker+supervisor wiring, and
// the SSE parsers reused across the per-topic e2e specs (proxy, tools, responses, multi-turn, …).
//
// These exercise the real worker + supervisor + slash modules wired together the way production wires
// them (worker metric sink -> supervisor db -> control API), with a fake Copilot provider so no live
// network is touched. Every code update must keep the e2e specs green.
//
// Case catalog and latest results live next to this file: see cases.md and RESULTS.md.
// This file is NOT a `*.e2e.test.ts`, so vitest does not collect it as a suite — it only holds helpers.
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import { CopilotAuthError } from "../src/providers/copilot/token.js";
import { openDb, recordRequest } from "../src/supervisor/db.js";
import { createControlApp } from "../src/supervisor/api.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { CanonicalChunk } from "../src/core/canonical.js";
import type { GatewayToolRunner } from "../src/core/server-tools.js";

export const ok: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
export const failing: ProviderAdapter = {
  name: "copilot",
  complete: async () => { throw new Error("context_length_exceeded"); },
  async *stream(): AsyncIterable<CanonicalChunk> {
    yield { kind: "text", delta: "partial", done: false };
    throw new Error("context_length_exceeded: prompt too long");
  },
};

// Wire a worker app to a supervisor db exactly like the daemon does (metric -> recordRequest).
// An optional gatewayRunner is forwarded so e2e cases can exercise the in-gateway web_search/web_fetch
// loop (production passes a real runner; the daemon's createWorkerApp takes it as the 3rd arg).
export function wired(provider: ProviderAdapter, runner?: GatewayToolRunner) {
  const db = openDb(":memory:");
  const worker = createWorkerApp(new Router([provider], { "*": "gpt-4o" }), (m) => recordRequest(db, { ts: Date.now(), ...m }), runner);
  const control = createControlApp({ db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [{ name: "worker", ok: true, detail: "ready" }], github: () => undefined, clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }), models: async () => [], subscribe: () => () => {} });
  return { worker, control, db };
}

// ---- fake-provider factories (deterministic, no network) -----------------------------------------

// A provider that streams a single tool_use (one tool call) then finishes with stop_reason tool_use.
export function toolStreamProvider(name: string, args: string, id = "call_1"): ProviderAdapter {
  return {
    name: "copilot",
    complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "tool_use", id, name, input: JSON.parse(args || "{}") }], finishReason: "tool_use", usage: { promptTokens: 2, completionTokens: 1 } }),
    async *stream() {
      yield { kind: "tool_use_start", index: 0, id, name, done: false } as const;
      yield { kind: "tool_use_delta", index: 0, argsDelta: args, done: false } as const;
      yield { kind: "done", done: true, finishReason: "tool_use" } as const;
    },
  };
}

// A provider driven by a turn counter: turn 1 calls `toolName` (a gateway tool), later turns return
// `finalText`. The endpoint re-invokes stream()/complete() per loop iteration, so the counter selects
// behavior — this drives the gateway tool loop deterministically.
export function loopProvider(toolName: string, finalText: string, opts: { capForever?: boolean } = {}) {
  let turn = 0;
  const adapter: ProviderAdapter = {
    name: "copilot",
    complete: async (req) => {
      turn++;
      if (opts.capForever || turn === 1) return { id: "c1", model: req.model, content: [{ type: "tool_use", id: `call_${turn}`, name: toolName, input: { query: "q" } }], finishReason: "tool_use", usage: { promptTokens: 2, completionTokens: 1 } };
      return { id: "c1", model: req.model, content: [{ type: "text", text: finalText }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } };
    },
    async *stream() {
      turn++;
      if (opts.capForever || turn === 1) {
        yield { kind: "tool_use_start", index: 0, id: `call_${turn}`, name: toolName, done: false } as const;
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"query":"q"}', done: false } as const;
        yield { kind: "done", done: true, finishReason: "tool_use" } as const;
      } else {
        yield { kind: "text", delta: finalText, done: false } as const;
        yield { kind: "done", done: true, finishReason: "stop" } as const;
      }
    },
  };
  return { adapter, turns: () => turn };
}

// A provider that throws CopilotAuthError (for the 401 path) — optionally after a text yield so the
// failure lands on an already-open stream.
export function authFailProvider(afterText = false): ProviderAdapter {
  return {
    name: "copilot",
    complete: async () => { throw new CopilotAuthError(401); },
    async *stream(): AsyncIterable<CanonicalChunk> {
      if (afterText) yield { kind: "text", delta: "partial", done: false };
      throw new CopilotAuthError(401);
    },
  };
}

// Parse OpenAI Responses SSE (`data: {json}` frames, no event: lines) into ordered objects.
export function responsesEvents(body: string): any[] {
  return body.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
    .filter((d): d is string => !!d && d.trim() !== "[DONE]").map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
}

// Parse an SSE body into ordered { event, data } frames (Anthropic) — shared by streaming cases.
export function frames(body: string): { event: string; data: any }[] {
  return body.split("\n\n").map((b) => b.trim()).filter(Boolean).map((b) => ({
    event: b.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "",
    data: JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}"),
  }));
}
// Parse OpenAI `data: {json}` SSE lines (skips [DONE]).
export function openaiChunks(body: string): any[] {
  return body.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))?.slice(6)).filter((d): d is string => !!d && d.trim() !== "[DONE]").map((d) => JSON.parse(d));
}
