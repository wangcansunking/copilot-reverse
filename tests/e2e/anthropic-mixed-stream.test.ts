import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

// Provider that emits PREAMBLE TEXT, then a TOOL CALL — the mixed turn that
// exercises interface-freeze §5.4 (the D3 index-collision path the assistant
// dogfood loop hits). Text lands at Anthropic block index 0; the tool call must
// land at a DIFFERENT index, with content_block_stop closing the text block
// before the tool block opens.
const mixedProvider: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "thinking" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }),
  async *stream() {
    yield { kind: "text", delta: "let me check", done: false } as const;
    yield { kind: "tool_use_start", index: 0, id: "tu1", name: "get_status", done: false } as const;
    yield { kind: "tool_use_delta", index: 0, argsDelta: "{}", done: false } as const;
    yield { kind: "done", done: true, finishReason: "tool_use" } as const;
  },
};
const app = () => createWorkerApp(new Router([mixedProvider], { "*": "gpt-4o" }), () => {});

interface Frame { event: string; data: any }
function parseFrames(sse: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of sse.split("\n\n")) {
    const ev = block.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
    const dl = block.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || !dl) continue;
    try { frames.push({ event: ev, data: JSON.parse(dl) }); } catch { /* skip */ }
  }
  return frames;
}

describe("Anthropic mixed text+tool streaming (§5.4 / D3 regression)", () => {
  it("text and tool_use occupy DISTINCT block indices (no index-0 collision)", async () => {
    const res = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "status?" }] });
    const frames = parseFrames(res.text);

    const starts = frames.filter((f) => f.event === "content_block_start");
    const textStart = starts.find((f) => f.data.content_block?.type === "text");
    const toolStart = starts.find((f) => f.data.content_block?.type === "tool_use");

    expect(textStart, "a text block should open").toBeTruthy();
    expect(toolStart, "a tool_use block should open").toBeTruthy();
    // The core D3 invariant: the two blocks must NOT share an index.
    expect(toolStart!.data.index).not.toBe(textStart!.data.index);

    // Every opened block index must be closed by a content_block_stop.
    const stopIdx = new Set(frames.filter((f) => f.event === "content_block_stop").map((f) => f.data.index));
    expect(stopIdx.has(textStart!.data.index)).toBe(true);
    expect(stopIdx.has(toolStart!.data.index)).toBe(true);

    // Terminates correctly.
    expect(frames.some((f) => f.event === "message_stop")).toBe(true);
  });
});
