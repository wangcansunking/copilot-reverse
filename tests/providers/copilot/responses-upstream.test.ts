import { describe, it, expect } from "vitest";
import { canonicalToResponsesBody, parseResponsesResult, streamResponses, RESPONSES_URL } from "../../../src/providers/copilot/responses-upstream.js";
import type { CanonicalRequest, CanonicalChunk } from "../../../src/core/canonical.js";

const sseResponse = (events: unknown[]): Response =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const drain = async (it: AsyncIterable<CanonicalChunk>): Promise<CanonicalChunk[]> => { const out: CanonicalChunk[] = []; for await (const c of it) out.push(c); return out; };

describe("canonicalToResponsesBody", () => {
  it("routes system to instructions and user text to an input_text message item", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.5", stream: true, temperature: 0.5, maxTokens: 256,
      messages: [
        { role: "system", content: [{ type: "text", text: "be terse" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    };
    const body = canonicalToResponsesBody(req);
    expect(body.model).toBe("gpt-5.5");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.max_output_tokens).toBe(256);
    expect(body.instructions).toBe("be terse");
    expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  });

  it("maps assistant tool_use to function_call and tool_result to function_call_output", () => {
    const body = canonicalToResponsesBody({
      model: "gpt-5.5", stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_A", name: "now", input: { tz: "utc" } }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "call_A", content: "12:00" }] },
      ],
    });
    expect(body.input[1]).toEqual({ type: "function_call", call_id: "call_A", name: "now", arguments: '{"tz":"utc"}' });
    expect(body.input[2]).toEqual({ type: "function_call_output", call_id: "call_A", output: "12:00" });
  });

  it("represents assistant text history with an output_text part", () => {
    const body = canonicalToResponsesBody({
      model: "gpt-5.5", stream: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "prior answer" }] }],
    });
    expect(body.input[0]).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] });
  });

  it("maps an image block to an input_image part", () => {
    const body = canonicalToResponsesBody({
      model: "gpt-5.5", stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", dataUrl: "data:image/png;base64,XYZ" }] }],
    });
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: "data:image/png;base64,XYZ" },
    ]);
  });

  it("maps canonical tools to function tools", () => {
    const body = canonicalToResponsesBody({
      model: "gpt-5.5", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "search", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(body.tools).toEqual([{ type: "function", name: "search", description: "d", parameters: { type: "object", properties: {} } }]);
  });

  it("forwards hosted tools (web_search) as {type} entries alongside function tools", () => {
    const body = canonicalToResponsesBody({
      model: "gpt-5.5", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "search", description: "d", parameters: {} }],
      hostedTools: ["web_search"],
    });
    expect(body.tools).toContainEqual({ type: "web_search" });
    expect(body.tools).toContainEqual(expect.objectContaining({ type: "function", name: "search" }));
  });

  it("forwards hosted web_search even when there are no function tools", () => {
    const body = canonicalToResponsesBody({
      model: "gpt-5.5", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      hostedTools: ["web_search"],
    });
    expect(body.tools).toEqual([{ type: "web_search" }]);
  });
});

describe("parseResponsesResult", () => {
  it("extracts output_text from message items and skips reasoning", () => {
    const r = parseResponsesResult({
      id: "resp_1", model: "gpt-5.5",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello!", annotations: [] }] },
      ],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    });
    expect(r.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ promptTokens: 20, completionTokens: 5 });
  });

  it("extracts function_call items as tool_use and reports tool_use finish", () => {
    const r = parseResponsesResult({
      id: "resp_2", model: "gpt-5.5",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_X", name: "get_weather", arguments: '{"city":"SF"}', status: "completed" }],
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(r.content).toEqual([{ type: "tool_use", id: "call_X", name: "get_weather", input: { city: "SF" } }]);
    expect(r.finishReason).toBe("tool_use");
  });

  it("maps an incomplete (max_output_tokens) response to length", () => {
    const r = parseResponsesResult({
      id: "resp_3", model: "gpt-5.5", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(r.finishReason).toBe("length");
  });
});

describe("streamResponses", () => {
  it("yields text deltas and a done chunk with usage", async () => {
    const chunks = await drain(streamResponses(sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" },
      { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } },
    ])));
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).delta).join("");
    expect(text).toBe("Hello");
    const done = chunks.find((c) => c.done) as any;
    expect(done.finishReason).toBe("stop");
    expect(done.usage).toEqual({ promptTokens: 10, completionTokens: 2, cachedTokens: 4 });
  });

  it("yields tool_use_start + accumulated args and a tool_use finish", async () => {
    const chunks = await drain(streamResponses(sseResponse([
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_X", name: "get_weather", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"city"' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: ':"SF"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"city":"SF"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_X", name: "get_weather", arguments: '{"city":"SF"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } },
    ])));
    const start = chunks.find((c) => c.kind === "tool_use_start") as any;
    expect(start).toMatchObject({ id: "call_X", name: "get_weather" });
    const args = chunks.filter((c) => c.kind === "tool_use_delta").map((c) => (c as any).argsDelta).join("");
    expect(JSON.parse(args)).toEqual({ city: "SF" });
    expect((chunks.find((c) => c.done) as any).finishReason).toBe("tool_use");
  });

  it("maps a response.incomplete (max_output_tokens) terminal event to length", async () => {
    const chunks = await drain(streamResponses(sseResponse([
      { type: "response.created", response: { id: "resp_3" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "partial" },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } },
    ])));
    expect((chunks.find((c) => c.done) as any).finishReason).toBe("length");
  });

  it("exposes the Copilot responses URL", () => {
    expect(RESPONSES_URL).toBe("https://api.githubcopilot.com/responses");
  });
});
