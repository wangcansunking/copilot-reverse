import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import type { CanonicalChunk } from "../../src/core/canonical.js";

const textProvider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "c1", model: "m", content: [{ type: "text", text: "hello" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "he", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = (p: ProviderAdapter = textProvider) => createWorkerApp(new Router([p], { "*": "gpt-4o" }), () => {});

// Splits an SSE body into ordered { event, data } frames.
function parseFrames(body: string): { event: string; data: any }[] {
  return body
    .split("\n\n")
    .map((blk) => blk.trim())
    .filter(Boolean)
    .map((blk) => {
      const event = blk.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "";
      const dataLine = blk.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(dataLine) };
    });
}

describe("worker Anthropic endpoint", () => {
  it("non-stream message", async () => {
    const res = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.content[0].text).toBe("hello");
  });

  it("SSE message stream begins with message_start", async () => {
    const res = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("message_start");
    expect(res.text).toContain('"text":"he"');
    expect(res.text).toContain("message_stop");
  });

  it("text stream opens index-0 text block lazily and closes it before message_stop", async () => {
    const res = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);
    // exactly one content_block_start at index 0 of type text
    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data.index).toBe(0);
    expect(starts[0].data.content_block.type).toBe("text");
    // a matching content_block_stop, before message_delta/message_stop
    expect(events.filter((e) => e === "content_block_stop")).toHaveLength(1);
    expect(events.indexOf("content_block_stop")).toBeLessThan(events.indexOf("message_delta"));
    expect(events.indexOf("message_delta")).toBeLessThan(events.indexOf("message_stop"));
    expect(events[events.length - 1]).toBe("message_stop");
  });

  it("pure tool-call stream: no phantom text block at index 0, tool opens+closes at its own index", async () => {
    const toolProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "now", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"x":1}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(app(toolProvider)).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);

    // (a) no phantom empty TEXT content_block_start at index 0
    const textStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "text");
    expect(textStarts).toHaveLength(0);

    // (b) exactly one tool_use content_block_start, at its own index (0 here), with matching stop
    const toolStarts = frames.filter((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].data.index).toBe(0);
    expect(toolStarts[0].data.content_block.name).toBe("now");
    expect(events.filter((e) => e === "content_block_stop")).toHaveLength(1);

    // the input_json_delta arrives between start and stop
    const startIdx = events.indexOf("content_block_start");
    const stopIdx = events.indexOf("content_block_stop");
    const deltaIdx = events.indexOf("content_block_delta");
    expect(startIdx).toBeLessThan(deltaIdx);
    expect(deltaIdx).toBeLessThan(stopIdx);
    expect(res.text).toContain("input_json_delta");

    // (c) correct ordering: starts with message_start, ends with message_stop, stop before message_delta
    expect(events[0]).toBe("message_start");
    expect(events[events.length - 1]).toBe("message_stop");
    expect(stopIdx).toBeLessThan(events.indexOf("message_delta"));
    // stop_reason propagated as tool_use
    const delta = frames.find((f) => f.event === "message_delta");
    expect(delta?.data.delta.stop_reason).toBe("tool_use");
  });

  it("mixed text+tool stream: leading text claims index 0, tool claims index 1, both stop, stop_reason=tool_use", async () => {
    const mixedProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "tu1", name: "now", input: { x: 1 } }], finishReason: "tool_use", usage: { promptTokens: 2, completionTokens: 2 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "let me ", done: false };
        yield { kind: "text", delta: "check", done: false };
        yield { kind: "tool_use_start", index: 0, id: "tu1", name: "now", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"x":1}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(app(mixedProvider)).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);

    // text block opens at Anthropic index 0
    const textStart = frames.find((f) => f.event === "content_block_start" && f.data.content_block?.type === "text");
    expect(textStart).toBeDefined();
    expect(textStart!.data.index).toBe(0);

    // tool block opens at Anthropic index 1 (NOT colliding with text@0, NOT a static +1 either — sequential alloc)
    const toolStart = frames.find((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use");
    expect(toolStart).toBeDefined();
    expect(toolStart!.data.index).toBe(1);
    expect(toolStart!.data.content_block.name).toBe("now");

    // exactly two block starts and two matching stops (one per allocated index)
    expect(frames.filter((f) => f.event === "content_block_start")).toHaveLength(2);
    const stops = frames.filter((f) => f.event === "content_block_stop");
    expect(stops).toHaveLength(2);
    expect(stops.map((f) => f.data.index).sort((a: number, b: number) => a - b)).toEqual([0, 1]);

    // text_delta routes to index 0, input_json_delta routes to index 1
    const textDelta = frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "text_delta");
    expect(textDelta!.data.index).toBe(0);
    const jsonDelta = frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "input_json_delta");
    expect(jsonDelta!.data.index).toBe(1);

    // ordering: message_start first, all content_block_stop before message_delta, message_stop last
    expect(events[0]).toBe("message_start");
    expect(events[events.length - 1]).toBe("message_stop");
    const lastStop = events.lastIndexOf("content_block_stop");
    expect(lastStop).toBeLessThan(events.indexOf("message_delta"));
    expect(frames.find((f) => f.event === "message_delta")?.data.delta.stop_reason).toBe("tool_use");
  });

  it("count_tokens returns a positive input_tokens estimate", async () => {
    const res = await request(app()).post("/v1/messages/count_tokens").send({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hello world this is a longer prompt" }] });
    expect(res.status).toBe(200);
    expect(typeof res.body.input_tokens).toBe("number");
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  it("emits an Anthropic error SSE frame (not a silent close) when the provider stream throws mid-stream", async () => {
    const failing: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "error", usage: { promptTokens: 0, completionTokens: 0 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "partial ", done: false };
        throw new Error("context_length_exceeded: prompt is too long");
      },
    };
    const res = await request(app(failing)).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    const frames = parseFrames(res.text);
    const events = frames.map((f) => f.event);
    // the stream must surface the failure as an Anthropic `error` event, not just stop
    expect(events).toContain("error");
    const err = frames.find((f) => f.event === "error");
    expect(err!.data.type).toBe("error");
    expect(err!.data.error.message).toMatch(/context_length_exceeded/);
  });

  it("records the failure message in the metric when a streaming request throws", async () => {
    const failing: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "error", usage: { promptTokens: 0, completionTokens: 0 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "x", done: false };
        throw new Error("context_length_exceeded");
      },
    };
    const metrics: { status: number; error?: string }[] = [];
    const sink = (m: { status: number; error?: string }) => { metrics.push(m); };
    const a = createWorkerApp(new Router([failing], { "*": "gpt-4o" }), sink);
    await request(a).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(metrics.at(-1)?.status).toBe(502);
    expect(metrics.at(-1)?.error).toMatch(/context_length_exceeded/);
  });

  it("text + two tools: contiguous indices [0,1,2], deltas routed to mapped indices, three stops", async () => {
    const multiProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "checking both", done: false };
        yield { kind: "tool_use_start", index: 0, id: "tuA", name: "alpha", done: false };
        yield { kind: "tool_use_delta", index: 0, argsDelta: '{"a":1}', done: false };
        yield { kind: "tool_use_start", index: 1, id: "tuB", name: "beta", done: false };
        yield { kind: "tool_use_delta", index: 1, argsDelta: '{"b":2}', done: false };
        yield { kind: "done", done: true, finishReason: "tool_use" };
      },
    };
    const res = await request(app(multiProvider)).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "go" }] });
    const frames = parseFrames(res.text);

    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts.map((f) => f.data.index)).toEqual([0, 1, 2]);
    expect(starts[0].data.content_block.type).toBe("text");
    expect(starts[1].data.content_block).toMatchObject({ type: "tool_use", name: "alpha" });
    expect(starts[2].data.content_block).toMatchObject({ type: "tool_use", name: "beta" });

    // text_delta -> 0, alpha's input_json_delta -> 1, beta's -> 2
    expect(frames.find((f) => f.event === "content_block_delta" && f.data.delta?.type === "text_delta")!.data.index).toBe(0);
    const jsonDeltas = frames.filter((f) => f.event === "content_block_delta" && f.data.delta?.type === "input_json_delta");
    expect(jsonDeltas.map((f) => f.data.index)).toEqual([1, 2]);
    expect(jsonDeltas[0].data.delta.partial_json).toBe('{"a":1}');
    expect(jsonDeltas[1].data.delta.partial_json).toBe('{"b":2}');

    // three stops, ascending, all before message_delta
    const stops = frames.filter((f) => f.event === "content_block_stop");
    expect(stops.map((f) => f.data.index)).toEqual([0, 1, 2]);
    const events = frames.map((f) => f.event);
    expect(events.lastIndexOf("content_block_stop")).toBeLessThan(events.indexOf("message_delta"));
    expect(events[events.length - 1]).toBe("message_stop");
  });
});
