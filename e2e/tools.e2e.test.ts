// E2E: tool-call translation in both directions (mixed text+tool streams, non-stream tool_use,
// extended-thinking blocks, reasoning-effort passthrough, OpenAI tool round-trip).
// Case catalog: cases.md. Shared harness: helpers.ts.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { wired, frames } from "./helpers.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { CanonicalChunk } from "../src/core/canonical.js";

describe("E2E: tool calls", () => {
  const toolProvider: ProviderAdapter = {
    name: "copilot",
    complete: async () => ({ id: "c1", model: "m", content: [{ type: "tool_use", id: "tu1", name: "now", input: { x: 1 } }], finishReason: "tool_use", usage: { promptTokens: 1, completionTokens: 1 } }),
    async *stream(): AsyncIterable<CanonicalChunk> {
      yield { kind: "text", delta: "let me check", done: false };
      yield { kind: "tool_use_start", index: 0, id: "tu1", name: "now", done: false };
      yield { kind: "tool_use_delta", index: 0, argsDelta: '{"x":1}', done: false };
      yield { kind: "done", done: true, finishReason: "tool_use" };
    },
  };

  it("EP-18 mixed text+tool stream: text@0, tool@1, stop_reason=tool_use", async () => {
    const { worker } = wired(toolProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "go" }] });
    const f = frames(res.text);
    const starts = f.filter((x) => x.event === "content_block_start");
    expect(starts.find((s) => s.data.content_block.type === "text")!.data.index).toBe(0);
    expect(starts.find((s) => s.data.content_block.type === "tool_use")!.data.index).toBe(1);
    expect(f.find((x) => x.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use");
  });

  it("EP-19 a non-stream tool_use response maps to Anthropic tool_use content", async () => {
    const { worker } = wired(toolProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "go" }] });
    expect(res.body.stop_reason).toBe("tool_use");
    expect(res.body.content.find((b: any) => b.type === "tool_use").name).toBe("now");
  });

  it("EP-19b extended thinking: a thinking stream yields an Anthropic thinking block (thinking_delta + signature) before the text", async () => {
    const thinker: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [{ type: "thinking", text: "reasoning", opaque: "S" }, { type: "text", text: "answer" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "thinking", delta: "let me ", opaque: "S", done: false };
        yield { kind: "thinking", delta: "think", done: false };
        yield { kind: "text", delta: "answer", done: false };
        yield { kind: "done", done: true, finishReason: "stop" };
      },
    };
    const { worker } = wired(thinker);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, thinking: { type: "enabled", budget_tokens: 8000 }, messages: [{ role: "user", content: "hard" }] });
    const f = frames(res.text);
    const starts = f.filter((x) => x.event === "content_block_start");
    // thinking block opens at index 0 (before text at 1); reasoning streams as thinking_delta
    expect(starts.find((s) => s.data.content_block.type === "thinking")!.data.index).toBe(0);
    expect(starts.find((s) => s.data.content_block.type === "text")!.data.index).toBe(1);
    const think = f.filter((x) => x.event === "content_block_delta" && x.data.delta.type === "thinking_delta").map((x) => x.data.delta.thinking).join("");
    expect(think).toBe("let me think");
    // a signature_delta carries the opaque continuation token before the thinking block closes
    expect(f.some((x) => x.event === "content_block_delta" && x.data.delta.type === "signature_delta" && x.data.delta.signature === "S")).toBe(true);
  });

  it("EP-19c a client-sent thinking budget reaches the provider as canonical reasoning effort", async () => {
    let seen: any;
    const spy: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seen = req; return { id: "c1", model: "m", content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const { worker } = wired(spy);
    await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 20, thinking: { type: "enabled", budget_tokens: 16000 }, messages: [{ role: "user", content: "hi" }] });
    expect(seen.reasoning).toEqual({ effort: "high" }); // 16k budget -> high bucket
  });

  it("EP-20 OpenAI tool round-trip: an assistant tool_call + tool result reach the provider", async () => {
    let seen: any;
    const echo: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seen = req.messages; return { id: "c1", model: "m", content: [{ type: "text", text: "done" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const { worker } = wired(echo);
    await request(worker).post("/openai/chat/completions").send({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "what time?" },
        { role: "assistant", content: null, tool_calls: [{ id: "A", type: "function", function: { name: "now", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "A", content: "12:00" },
      ],
    });
    const toolMsg = seen.find((m: any) => m.content?.some?.((b: any) => b.type === "tool_result"));
    expect(toolMsg).toBeDefined();
  });
});
