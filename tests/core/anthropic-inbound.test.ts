import { describe, it, expect } from "vitest";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse, canonicalChunkToAnthropicSSE } from "../../src/core/anthropic-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("anthropic inbound", () => {
  it("normalizes request incl tools + tool_result", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100, stream: true,
      system: "be brief",
      tools: [{ name: "now", description: "t", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "now", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "12:00" }] },
      ],
    });
    expect(c.model).toBe("claude-opus-4-8");
    expect(c.stream).toBe(true);
    expect(c.messages[0].role).toBe("system");
    expect(c.tools?.[0].name).toBe("now");
    expect(c.messages[3].content[0]).toEqual({ type: "tool_result", toolUseId: "tu1", content: "12:00" });
  });

  it("builds anthropic response with tool_use block", () => {
    const r: CanonicalResponse = {
      id: "r1", model: "claude-opus-4-8",
      content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "tu1", name: "now", input: { x: 1 } }],
      finishReason: "tool_use", usage: { promptTokens: 5, completionTokens: 2 },
    };
    const out = canonicalToAnthropicResponse(r);
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[1]).toEqual({ type: "tool_use", id: "tu1", name: "now", input: { x: 1 } });
    expect(out.usage.output_tokens).toBe(2);
  });

  it("emits anthropic SSE frames for a text delta and stop", () => {
    const frames = canonicalChunkToAnthropicSSE({ kind: "text", delta: "he", done: false }, { index: 0 });
    expect(frames).toContain("content_block_delta");
    expect(frames).toContain('"text":"he"');
    expect(canonicalChunkToAnthropicSSE({ kind: "done", done: true, finishReason: "stop" }, { index: 0 })).toContain("message_stop");
  });
});
