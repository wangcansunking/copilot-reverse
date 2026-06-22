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
});
