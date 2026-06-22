import { describe, it, expect } from "vitest";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse } from "../../src/core/anthropic-inbound.js";
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

  it("flattens an array-of-blocks system prompt (SDK sends cache_control blocks) into text", () => {
    const c = anthropicRequestToCanonical({
      model: "gpt-4o", max_tokens: 100,
      system: [{ type: "text", text: "You are " }, { type: "text", text: "copilot-reverse." }] as any,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(c.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "You are copilot-reverse." }] });
  });

  it("converts an Anthropic image block (base64 + url) to a canonical image block", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } } as any,
        { type: "image", source: { type: "url", url: "https://x/y.jpg" } } as any,
      ] }],
    });
    const blocks = c.messages[0].content;
    expect(blocks[0]).toEqual({ type: "text", text: "what is this?" });
    expect(blocks[1]).toEqual({ type: "image", dataUrl: "data:image/png;base64,AAAA" });
    expect(blocks[2]).toEqual({ type: "image", dataUrl: "https://x/y.jpg" });
  });

  it("drops Anthropic server-side tools that have no input_schema (prevents client hang)", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 } as any,
        { type: "bash_20250124", name: "bash" } as any,
      ],
    });
    expect(c.tools?.map((t) => t.name)).toEqual(["get_weather"]);
  });
});
