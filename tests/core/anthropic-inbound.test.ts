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

  it("converts web_search/web_fetch server tools to function tools, still drops others (bash/computer)", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 } as any,
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 } as any,
        { type: "bash_20250124", name: "bash" } as any,
      ],
    });
    const names = c.tools?.map((t) => t.name) ?? [];
    // Custom tool kept, both web_* tools converted (now carry a real schema), bash dropped.
    expect(names).toContain("get_weather");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("bash");
    const ws = c.tools?.find((t) => t.name === "web_search");
    expect((ws?.parameters as any)?.type).toBe("object");
    expect((ws?.parameters as any)?.properties?.query).toBeTruthy();
  });

  it("maps an Anthropic thinking budget to a canonical reasoning effort", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100,
      messages: [{ role: "user", content: "hard problem" }],
      thinking: { type: "enabled", budget_tokens: 16000 },
    } as any);
    expect(c.reasoning).toEqual({ effort: "high" }); // 16k budget -> high bucket
  });

  it("leaves reasoning undefined when thinking is disabled or absent", () => {
    const off = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    } as any);
    const absent = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
    });
    expect(off.reasoning).toBeUndefined();
    expect(absent.reasoning).toBeUndefined();
  });

  it("parses a prior assistant thinking block (with signature) back into a canonical thinking block", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "earlier reasoning", signature: "OPAQUE99" },
          { type: "text", text: "earlier answer" },
        ] },
        { role: "user", content: "continue" },
      ],
    } as any);
    // the assistant turn's thinking block round-trips, carrying its opaque continuation token
    const assistantMsg = c.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.content[0]).toEqual({ type: "thinking", text: "earlier reasoning", opaque: "OPAQUE99" });
    expect(assistantMsg.content[1]).toEqual({ type: "text", text: "earlier answer" });
  });
});
