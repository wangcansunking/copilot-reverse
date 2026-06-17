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
});
