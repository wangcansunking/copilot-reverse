// End-to-end suite — exercises the real worker + supervisor + slash modules wired together
// the way production wires them (worker metric sink -> supervisor db -> control API), with a
// fake Copilot provider so no live network is touched. Every code update must keep these green.
//
// Case catalog and latest results live next to this file: see cases.md and RESULTS.md.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import { CopilotAuthError } from "../src/providers/copilot/token.js";
import { createControlApp } from "../src/supervisor/api.js";
import { openDb, recordRequest, recentRequests } from "../src/supervisor/db.js";
import { buildRegistry } from "../src/tui/slash/commands.js";
import { applyClaude, resetClaude, CLAUDE_ENV_KEYS } from "../src/tui/setup/apply.js";
import { claudeCopilotReverseEnv } from "../src/tui/setup/clients.js";
import { readClientStatus } from "../src/tui/setup/status.js";
import { applyCodexToml, codexTomlPath } from "../src/tui/setup/codex-toml.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { CanonicalChunk, CanonicalResponse } from "../src/core/canonical.js";
import type { GatewayToolRunner } from "../src/core/server-tools.js";

const ok: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const failing: ProviderAdapter = {
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
function wired(provider: ProviderAdapter, runner?: GatewayToolRunner) {
  const db = openDb(":memory:");
  const worker = createWorkerApp(new Router([provider], { "*": "gpt-4o" }), (m) => recordRequest(db, { ts: Date.now(), ...m }), runner);
  const control = createControlApp({ db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [{ name: "worker", ok: true, detail: "ready" }], github: () => undefined, clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }), models: async () => [], subscribe: () => () => {} });
  return { worker, control, db };
}

// ---- fake-provider factories (deterministic, no network) -----------------------------------------

// A provider that streams a single tool_use (one tool call) then finishes with stop_reason tool_use.
function toolStreamProvider(name: string, args: string, id = "call_1"): ProviderAdapter {
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
function loopProvider(toolName: string, finalText: string, opts: { capForever?: boolean } = {}) {
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
function authFailProvider(afterText = false): ProviderAdapter {
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
function responsesEvents(body: string): any[] {
  return body.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
    .filter((d): d is string => !!d && d.trim() !== "[DONE]").map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
}

// Parse an SSE body into ordered { event, data } frames (Anthropic) — shared by streaming cases.
function frames(body: string): { event: string; data: any }[] {
  return body.split("\n\n").map((b) => b.trim()).filter(Boolean).map((b) => ({
    event: b.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "",
    data: JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}"),
  }));
}
// Parse OpenAI `data: {json}` SSE lines (skips [DONE]).
function openaiChunks(body: string): any[] {
  return body.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))?.slice(6)).filter((d): d is string => !!d && d.trim() !== "[DONE]").map((d) => JSON.parse(d));
}

describe("E2E: proxy", () => {
  it("EP-01 Anthropic streaming yields message_start..delta..message_stop", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("message_start");
    expect(res.text).toContain('"text":"ok"');
    expect(res.text).toContain("message_stop");
  });

  it("EP-02 OpenAI completion returns assistant content", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.body.choices[0].message.content).toBe("ok");
  });

  it("EP-03 count_tokens returns a positive estimate", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages/count_tokens").send({ model: "claude-opus-4-8", messages: [{ role: "user", content: "count me" }] });
    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  it("EP-04 a request carrying an Anthropic server-side tool still completes (no hang)", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe("ok");
  });
});

describe("E2E: streaming correctness (this session's fixes)", () => {
  it("EP-10 each streamed Anthropic response gets a UNIQUE message id (no dedupe-to-first)", async () => {
    const { worker } = wired(ok);
    const send = () => request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const idOf = (text: string) => frames(text).find((f) => f.event === "message_start")!.data.message.id as string;
    const [a, b] = await Promise.all([send(), send()]);
    const idA = idOf(a.text), idB = idOf(b.text);
    expect(idA).toMatch(/^msg_/);
    expect(idA).not.toBe(idB);
  });

  it("EP-11 message_start carries a non-zero input_tokens estimate (context bar not stuck at 0)", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "a moderately long prompt here" }] });
    const start = frames(res.text).find((f) => f.event === "message_start");
    expect(start!.data.message.usage.input_tokens).toBeGreaterThan(0);
  });

  it("EP-12 message_delta reports real usage (input minus cached, output, cache_read)", async () => {
    const usageProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 100, completionTokens: 7 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "ok", done: false };
        yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 7, cachedTokens: 30 } };
      },
    };
    const { worker } = wired(usageProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const delta = frames(res.text).find((f) => f.event === "message_delta");
    expect(delta!.data.usage.input_tokens).toBe(70);
    expect(delta!.data.usage.output_tokens).toBe(7);
    expect(delta!.data.usage.cache_read_input_tokens).toBe(30);
  });

  it("EP-13 OpenAI stream emits a usage chunk before [DONE]", async () => {
    const usageProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 9, completionTokens: 2 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "ok", done: false };
        yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 9, completionTokens: 2 } };
      },
    };
    const { worker } = wired(usageProvider);
    const res = await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("data: [DONE]");
    const usageChunk = openaiChunks(res.text).find((c) => c.usage);
    expect(usageChunk.usage.total_tokens).toBe(11);
  });

  it("EP-14 a mid-stream OpenAI failure emits an error chunk, not a silent close", async () => {
    const { worker } = wired(failing);
    const res = await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("context_length_exceeded");
    expect(res.text).toContain('"error"');
  });

  it("EP-14b an expired token (401) surfaces a /login hint in the error body", async () => {
    const authFail: ProviderAdapter = {
      name: "copilot",
      complete: async () => { throw new CopilotAuthError(401); },
      async *stream(): AsyncIterable<CanonicalChunk> { throw new CopilotAuthError(401); },
    };
    const { worker } = wired(authFail);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/\/login/);
  });
});

describe("E2E: model resolution & 1M", () => {
  it("EP-15 fuzzy-matches a dated Anthropic id to the Copilot model", async () => {
    const db = openDb(":memory:");
    const router = new Router([ok], {});
    router.setAvailableModels(["claude-opus-4.8", "gpt-4o"]);
    const worker = createWorkerApp(router, (m) => recordRequest(db, { ts: Date.now(), ...m }));
    await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8-20251101", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(recentRequests(db, 1)[0].model).toBe("claude-opus-4.8");
  });

  it("EP-16 strips Claude Code's [1m] suffix before forwarding", async () => {
    const db = openDb(":memory:");
    const router = new Router([ok], {});
    router.setAvailableModels(["claude-opus-4.8"]);
    const worker = createWorkerApp(router, (m) => recordRequest(db, { ts: Date.now(), ...m }));
    await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4.8[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(recentRequests(db, 1)[0].model).toBe("claude-opus-4.8");
  });
});

describe("E2E: vision", () => {
  it("EP-17 an Anthropic image block round-trips through the proxy as image content", async () => {
    let seenContent: any;
    const visionProvider: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seenContent = req.messages[0].content; return { id: "c1", model: "m", content: [{ type: "text", text: "a cat" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const { worker } = wired(visionProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
    });
    expect(res.status).toBe(200);
    expect(seenContent.some((b: any) => b.type === "image" && b.dataUrl === "data:image/png;base64,AAAA")).toBe(true);
  });
});

describe("E2E: tool calls", () => {
  const toolProvider: ProviderAdapter = {
    name: "copilot",
    complete: async () => ({ id: "c1", model: "m", content: [{ type: "tool_use", id: "tu1", name: "now", input: { x: 1 } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
    async *stream(): AsyncIterable<CanonicalChunk> {
      yield { kind: "text", delta: "let me check", done: false };
      yield { kind: "tool_use_start", index: 0, id: "tu1", name: "now", done: false };
      yield { kind: "tool_use_delta", index: 0, argsDelta: '{"x":1}', done: false };
      yield { kind: "done", done: true, finishReason: "tool_use" };
    },
  };

  it("EP-18 mixed text+tool stream: text@0, tool@1, stop_reason=tool_use", async () => {
    const { worker } = wired(toolProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "go" }] });
    const f = frames(res.text);
    const starts = f.filter((x) => x.event === "content_block_start");
    expect(starts.find((s) => s.data.content_block.type === "text")!.data.index).toBe(0);
    expect(starts.find((s) => s.data.content_block.type === "tool_use")!.data.index).toBe(1);
    expect(f.find((x) => x.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use");
  });

  it("EP-19 a non-stream tool_use response maps to Anthropic tool_use content", async () => {
    const { worker } = wired(toolProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "go" }] });
    expect(res.body.stop_reason).toBe("tool_use");
    expect(res.body.content.find((b: any) => b.type === "tool_use").name).toBe("now");
  });

  it("EP-20 OpenAI tool round-trip: an assistant tool_call + tool result reach the provider", async () => {
    let seen: any;
    const echo: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seen = req.messages; return { id: "c1", model: "m", content: [{ type: "text", text: "done" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const { worker } = wired(echo);
    await request(worker).post("/openai/chat/completions").send({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "what time?" },
        { role: "assistant", content: null, tool_calls: [{ id: "A", type: "function", function: { name: "now", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "A", content: "12:00" },
      ],
    });
    const toolMsg = seen.find((m: any) => m.content?.some?.((b: any) => b.type === "tool_result"));
    expect(toolMsg).toBeDefined();
  });
});

// Codex speaks the OpenAI Responses API (/openai/responses). These drive the endpoint end-to-end
// through a booted worker — non-stream object shape, the full streaming event sequence, tool calls,
// inbound item round-trip, image input, instructions->system, hosted web_search passthrough, and
// errors — none of which the chat-completions cases cover.
describe("E2E: Codex /responses", () => {
  it("EP-27 non-stream returns a completed response object with output_text + usage", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi", max_output_tokens: 40 });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(res.body.status).toBe("completed");
    const msg = res.body.output.find((o: any) => o.type === "message");
    expect(msg.content[0]).toMatchObject({ type: "output_text", text: "ok" });
    expect(res.body.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
  });

  it("EP-28 streaming emits the ordered Responses event sequence with monotonic sequence_number", async () => {
    const withUsage: ProviderAdapter = { name: "copilot", complete: ok.complete, async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 5, completionTokens: 2 } } as const; } };
    const { worker } = wired(withUsage);
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi", stream: true, max_output_tokens: 40 });
    const evs = responsesEvents(res.text);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types.at(-1)).toBe("response.completed");
    const seqs = evs.map((e) => e.sequence_number);
    expect(seqs.every((n, i) => i === 0 || n > seqs[i - 1])).toBe(true); // strictly increasing
    const completed = evs.find((e) => e.type === "response.completed");
    expect(completed.response.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
  });

  it("EP-29 streaming a tool call emits function_call argument events, finish tool_use", async () => {
    const { worker } = wired(toolStreamProvider("get_weather", '{"city":"SF"}', "call_X"));
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "weather?", stream: true });
    const evs = responsesEvents(res.text);
    const added = evs.find((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
    expect(added.item).toMatchObject({ call_id: "call_X", name: "get_weather" });
    expect(evs.some((e) => e.type === "response.function_call_arguments.delta")).toBe(true);
    expect(evs.some((e) => e.type === "response.function_call_arguments.done")).toBe(true);
    const argsDone = evs.find((e) => e.type === "response.function_call_arguments.done");
    expect(JSON.parse(argsDone.arguments)).toEqual({ city: "SF" });
  });

  it("EP-30 non-stream tool call maps to a function_call output item", async () => {
    const { worker } = wired(toolStreamProvider("search", '{"q":"x"}', "fc1"));
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "search x" });
    const fc = res.body.output.find((o: any) => o.type === "function_call");
    expect(fc).toMatchObject({ call_id: "fc1", name: "search" });
    expect(JSON.parse(fc.arguments)).toEqual({ q: "x" });
  });

  it("EP-31 a prior function_call + function_call_output in input round-trips to the provider", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "done" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "fc1", name: "now", arguments: '{"tz":"utc"}' },
        { type: "function_call_output", call_id: "fc1", output: "12:00" },
      ],
    });
    expect(seen.messages.find((m: any) => m.content.some((b: any) => b.type === "tool_use" && b.id === "fc1"))).toBeTruthy();
    expect(seen.messages.find((m: any) => m.content.some((b: any) => b.type === "tool_result" && b.toolUseId === "fc1"))).toBeTruthy();
  });

  it("EP-32 an input_image content part round-trips to the provider as an image block", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "a cat" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "what?" }, { type: "input_image", image_url: "data:image/png;base64,XYZ" }] }],
    });
    const img = seen.messages.flatMap((m: any) => m.content).find((b: any) => b.type === "image");
    expect(img).toEqual({ type: "image", dataUrl: "data:image/png;base64,XYZ" });
  });

  it("EP-33 instructions become a system message", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({ model: "gpt-5.5", instructions: "be terse", input: "hello" });
    expect(seen.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "be terse" }] });
  });

  it("EP-34 a hosted web_search tool is passed through to the provider as a hostedTool", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "news?", tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: {} }] });
    expect(seen.hostedTools).toEqual(["web_search"]);
    expect(seen.tools?.some((t: any) => t.name === "f")).toBe(true); // function tool still present
  });

  it("EP-35 an expired token surfaces a 401 error object on /responses", async () => {
    const { worker } = wired(authFailProvider());
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi" });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("error");
    expect(res.body.error.message).toMatch(/login|expired/i);
  });

  it("EP-36 a mid-stream failure emits a data error frame, not a silent close", async () => {
    const { worker } = wired(authFailProvider(true)); // throws after a text yield (stream already open)
    const res = await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi", stream: true });
    expect(res.text).toMatch(/"type":"error"/);
  });

  it("EP-37 a /responses request is recorded in the supervisor request_log", async () => {
    const { worker, db } = wired(ok);
    await request(worker).post("/openai/responses").send({ model: "gpt-5.5", input: "hi" });
    const logged = recentRequests(db, 10);
    expect(logged.some((r) => r.endpoint === "/openai/responses" && r.status === 200)).toBe(true);
  });

  it("EP-38 resolveModel applies to /responses too (strips the [1m] suffix)", async () => {
    let seen: any;
    const spy: ProviderAdapter = { name: "copilot", async complete(req) { seen = req; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; }, async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; } };
    const { worker } = wired(spy);
    await request(worker).post("/openai/responses").send({ model: "gpt-4o[1m]", input: "hi" });
    expect(seen.model).not.toContain("[1m]");
  });
});

describe("E2E: persistence & control API", () => {
  it("EP-21 a failed request's error message persists in the request_log and is queryable", async () => {
    const { worker, control } = wired(failing);
    await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const res = await request(control).get("/api/requests");
    const failed = res.body.requests.find((r: any) => r.status >= 400);
    expect(failed.error).toMatch(/context_length_exceeded/);
  });

  it("EP-22 control API exposes status, doctor, and requests endpoints", async () => {
    const { control } = wired(ok);
    expect((await request(control).get("/api/status")).body.workerState).toBe("ready");
    expect((await request(control).get("/api/doctor")).body.checks[0].name).toBe("worker");
    expect(Array.isArray((await request(control).get("/api/requests")).body.requests)).toBe(true);
  });

  it("EP-23 db migration: a freshly opened db round-trips a recorded request", async () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1, endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 5 });
    expect(recentRequests(db, 1)[0].status).toBe(200);
  });
});

describe("E2E: setup lifecycle (Claude + Codex)", () => {
  it("EP-24 setup writes Claude config the HUD status then reports as configured (user scope)", async () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "e2e-cwd-"));
    applyClaude("global", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000), { home, cwd });
    const status = readClientStatus({ home, cwd });
    expect(status.claude.user).toBe(true);
    expect(status.claude.project).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    // Dashed canonical id (not Copilot's dotted claude-opus-4.8[1m]) so Claude Code's picker matches it.
    expect(settings.env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]");
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
  });

  it("EP-25 setup-codex writes a native config.toml with the model context window", () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-codex-"));
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7891/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    const toml = readFileSync(codexTomlPath(home), "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain("model_context_window = 1050000");
    expect(toml).toContain("[model_providers.copilot-reverse]");
  });

  it("EP-26 reset removes every key setup wrote, including the 1M-window keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-reset2-"));
    applyClaude("project", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000), { cwd });
    resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});



describe("E2E: error capture & dashboard", () => {
  it("EP-05 a failed stream surfaces an error frame AND lands in the control API + dashboard data", async () => {
    const { worker, control } = wired(failing);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("event: error");
    expect(res.text).toContain("context_length_exceeded");
    // the supervisor recorded the failure with its message
    const reqs = await request(control).get("/api/requests");
    const failed = reqs.body.requests.find((r: any) => r.status >= 400);
    expect(failed).toBeDefined();
    expect(failed.error).toMatch(/context_length_exceeded/);
  });

  it("EP-06 the supervisor serves the dashboard HTML at /", async () => {
    const { control } = wired(ok);
    const res = await request(control).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});

describe("E2E: TUI commands", () => {
  const ctx = () => ({
    client: {
      status: async () => ({ workerState: "ready" as const, restarts: [] }),
      restart: async () => {}, stop: async () => {}, start: async () => {},
      doctor: async () => [{ name: "worker", ok: true, detail: "ready" }],
      requests: async () => [{ ts: 1, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 4, error: "context_length_exceeded" }],
    },
    quit: () => {},
  });
  const endpoint = { host: "127.0.0.1", port: 7891, apiKey: "k" };

  it("EP-07 /logs surfaces recent request errors with their messages", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/logs");
    expect(out.join("\n")).toMatch(/context_length_exceeded/);
  });

  it("EP-08 /dashboard and /report open URLs in the browser", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { dashboardUrl: "http://127.0.0.1:7890/", reportRepo: "octo/copilot-reverse", appVersion: "0.0.1", openUrl: (u) => opened.push(u) });
    await reg.run("/dashboard");
    await reg.run("/report");
    expect(opened[0]).toBe("http://127.0.0.1:7890/");
    expect(opened[1]).toMatch(/^https:\/\/github\.com\/octo\/copilot-reverse\/issues\/new\?/);
  });

  it("EP-09 /reset removes the keys that setup wrote (round-trip)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-reset-"));
    applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "gpt-4o" }, { cwd });
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async () => resetClaude("project", CLAUDE_ENV_KEYS, { cwd }).changed });
    const out = await reg.run("/reset-claude");
    expect(out.join("\n")).toMatch(/ANTHROPIC_BASE_URL/);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
