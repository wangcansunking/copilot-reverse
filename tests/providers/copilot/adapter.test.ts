import { describe, it, expect, vi } from "vitest";
import { CopilotAdapter } from "../../../src/providers/copilot/adapter.js";
import type { CanonicalRequest } from "../../../src/core/canonical.js";

const tokenStore = { get: async () => "cop" };
const base: CanonicalRequest = { model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: false };

describe("CopilotAdapter", () => {
  it("completes non-stream", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      id: "c1", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const r = await a.complete(base);
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cop");
  });
  it("sends a canonical image block as an OpenAI image_url part on the wire", async () => {
    let body: any;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "a cat" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", dataUrl: "data:image/png;base64,XYZ" }] }],
    });
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,XYZ" } },
    ]);
  });

  it("expands parallel tool_results into one OpenAI tool message each (matched tool_call_ids)", async () => {
    let body: any;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    await a.complete({
      model: "gpt-4o", stream: false, maxTokens: 10,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "A", name: "f", input: {} }, { type: "tool_use", id: "B", name: "g", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "A", content: "ra" }, { type: "tool_result", toolUseId: "B", content: "rb" }] },
      ],
    });
    const toolMsgs = body.messages.filter((m: any) => m.role === "tool");
    // both tool_use ids must have a matching tool_result message — not just the first
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(["A", "B"]);
    expect(toolMsgs.map((m: any) => m.content)).toEqual(["ra", "rb"]);
  });

  it("streams text deltas", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' + 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' + "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    let out = "";
    for await (const c of a.stream({ ...base, stream: true })) if (c.kind === "text") out += c.delta;
    expect(out).toBe("hello");
  });

  it("captures usage + finish_reason from the final stream frame", async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"length","index":0,"delta":{}}],"usage":{"prompt_tokens":40,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":5}}}\n\n' +
      "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    let done: any;
    for await (const c of a.stream({ ...base, stream: true })) if (c.done) done = c;
    expect(done.finishReason).toBe("length");
    expect(done.usage).toEqual({ promptTokens: 40, completionTokens: 8, cachedTokens: 5 });
  });

  it("requests stream_options.include_usage on streaming calls", async () => {
    let body: any;
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); });
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    for await (const _ of a.stream({ ...base, stream: true })) { /* drain */ }
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  // --- Inline tool-call recovery: some models emit a tool call as TEXT XML instead of native
  // tool_calls. The adapter must recover it into structured tool chunks when the request has tools.
  // Tags are built via concatenation so no literal close-tag appears in this source file.
  const O = (t: string, a = "") => `<${t}${a}>`;
  const C = (t: string) => `</${t}>`;
  const degraded = O("function_calls") + O("invoke", ' name="Bash"') + O("parameter", ' name="command"') + "ls -la" + C("parameter") + C("invoke") + C("function_calls");
  const sseOf = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` + "data: [DONE]\n\n";
  const withTools: CanonicalRequest = { ...base, stream: true, tools: [{ name: "Bash", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } }] };

  it("recovers an inline tool call emitted as text into structured tool chunks (request has tools)", async () => {
    const f = vi.fn(async () => new Response(sseOf("let me check. " + degraded + " done"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream(withTools)) chunks.push(c);
    const start = chunks.find((c) => c.kind === "tool_use_start");
    const delta = chunks.find((c) => c.kind === "tool_use_delta");
    expect(start).toMatchObject({ name: "Bash" });
    expect(JSON.parse(delta.argsDelta)).toEqual({ command: "ls -la" });
    // surrounding prose still flows as text, tool call no longer leaks as text
    const text = chunks.filter((c) => c.kind === "text").map((c) => c.delta).join("");
    expect(text).toBe("let me check.  done");
    expect(text).not.toContain("invoke");
    // a text-emitted tool call must still report tool_use as the finish reason
    expect(chunks.find((c) => c.done)?.finishReason).toBe("tool_use");
  });

  it("recovers a tool call split across multiple SSE content deltas", async () => {
    const mid = Math.floor(degraded.length / 2);
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: degraded.slice(0, mid) } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: degraded.slice(mid) } }] })}\n\n` +
      "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream(withTools)) chunks.push(c);
    expect(chunks.find((c) => c.kind === "tool_use_start")).toMatchObject({ name: "Bash" });
    expect(JSON.parse(chunks.find((c) => c.kind === "tool_use_delta").argsDelta)).toEqual({ command: "ls -la" });
  });

  it("does NOT recover when the request has no tools (degraded-looking text passes through)", async () => {
    const f = vi.fn(async () => new Response(sseOf("here is the format: " + degraded), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const chunks: any[] = [];
    for await (const c of a.stream({ ...base, stream: true })) chunks.push(c); // base has no tools
    expect(chunks.some((c) => c.kind === "tool_use_start")).toBe(false);
    const text = chunks.filter((c) => c.kind === "text").map((c) => c.delta).join("");
    expect(text).toContain("invoke"); // raw text preserved verbatim, nothing eaten
  });
});
