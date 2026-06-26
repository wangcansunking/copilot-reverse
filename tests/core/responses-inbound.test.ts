import { describe, it, expect } from "vitest";
import { responsesRequestToCanonical, canonicalToResponsesResponse, ResponsesSSE } from "../../src/core/responses-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("responsesRequestToCanonical", () => {
  it("flattens instructions to a system message and a string input to a user message", () => {
    const c = responsesRequestToCanonical({ model: "gpt-5-mini", instructions: "be terse", input: "hello", stream: false });
    expect(c.model).toBe("gpt-5-mini");
    expect(c.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "be terse" }] });
    expect(c.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
  });

  it("maps input items: message / function_call / function_call_output", () => {
    const c = responsesRequestToCanonical({
      model: "gpt-5", stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "what time" }] },
        { type: "function_call", call_id: "fc1", name: "now", arguments: '{"tz":"utc"}' },
        { type: "function_call_output", call_id: "fc1", output: "12:00" },
      ],
    });
    expect(c.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "what time" }] });
    expect(c.messages[1].content[0]).toEqual({ type: "tool_use", id: "fc1", name: "now", input: { tz: "utc" } });
    expect(c.messages[2]).toEqual({ role: "tool", content: [{ type: "tool_result", toolUseId: "fc1", content: "12:00" }] });
  });

  it("maps function tools to canonical tools and ignores non-function tools", () => {
    const c = responsesRequestToCanonical({
      model: "gpt-5", stream: false, input: "hi",
      tools: [
        { type: "function", name: "search", description: "d", parameters: { type: "object", properties: {} } },
        { type: "web_search" },
      ] as any,
    });
    expect(c.tools).toHaveLength(1);
    expect(c.tools![0]).toMatchObject({ name: "search" });
  });
});

describe("canonicalToResponsesResponse", () => {
  it("wraps text in an output_text message item with usage", () => {
    const r: CanonicalResponse = { id: "r1", model: "gpt-5", content: [{ type: "text", text: "hi there" }], finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } };
    const out = canonicalToResponsesResponse(r);
    expect(out.object).toBe("response");
    expect(out.status).toBe("completed");
    const msg = out.output.find((o: any) => o.type === "message");
    expect(msg.content[0]).toMatchObject({ type: "output_text", text: "hi there" });
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 3, total_tokens: 13 });
  });

  it("emits function_call items for tool_use blocks", () => {
    const r: CanonicalResponse = { id: "r1", model: "gpt-5", content: [{ type: "tool_use", id: "fc1", name: "search", input: { q: "x" } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } };
    const out = canonicalToResponsesResponse(r);
    const fc = out.output.find((o: any) => o.type === "function_call");
    expect(fc).toMatchObject({ type: "function_call", call_id: "fc1", name: "search" });
    expect(JSON.parse(fc.arguments)).toEqual({ q: "x" });
  });
});

describe("ResponsesSSE emitter", () => {
  it("emits the ordered text event sequence with monotonic sequence_number", () => {
    const sse = new ResponsesSSE("resp_1", "gpt-5");
    const out: string[] = [];
    out.push(sse.start());
    out.push(...[sse.text("Hel"), sse.text("lo")].flat());
    out.push(...sse.finish({ promptTokens: 1, completionTokens: 1 }, "stop"));
    const events = out.join("").split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types.filter((t) => t === "response.output_text.delta")).toHaveLength(2);
    expect(types).toContain("response.output_text.done");
    expect(types.at(-1)).toBe("response.completed");
    // sequence_number is present and strictly increasing
    const seqs = events.map((e) => e.sequence_number);
    expect(seqs.every((n, i) => i === 0 || n > seqs[i - 1])).toBe(true);
  });

  it("emits function_call argument events for a tool call", () => {
    const sse = new ResponsesSSE("resp_2", "gpt-5");
    const out: string[] = [];
    out.push(sse.start());
    out.push(...sse.toolStart(0, "fc1", "search"));
    out.push(...sse.toolArgs(0, '{"q":1}'));
    out.push(...sse.finish({ promptTokens: 1, completionTokens: 1 }, "tool_use"));
    const text = out.join("");
    expect(text).toContain("response.output_item.added");
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain("response.function_call_arguments.done");
    expect(text).toContain("response.completed");
  });
});
