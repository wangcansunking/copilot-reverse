// E2E: core proxy translation + streaming correctness. Covers the OpenAI/Anthropic <-> Copilot
// canonical round-trip, streaming framing, and the usage/id/error-surfacing fixes.
// Case catalog: cases.md. Shared harness: helpers.ts.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { wired, ok, failing, frames, openaiChunks } from "./helpers.js";
import { CopilotAuthError } from "../src/providers/copilot/token.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { CanonicalChunk } from "../src/core/canonical.js";

describe("E2E: proxy", () => {
  it("EP-01 Anthropic streaming yields message_start..delta..message_stop", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("message_start");
    expect(res.text).toContain('"text":"ok"');
    expect(res.text).toContain("message_stop");
  });

  it("EP-02 OpenAI completion returns assistant content", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.body.choices[0].message.content).toBe("ok");
  });

  it("EP-03 count_tokens returns a positive estimate", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages/count_tokens").send({ model: "claude-opus-4-8", messages: [{ role: "user", content: "count me" }] });
    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  it("EP-04 a request carrying an Anthropic server-side tool still completes (no hang)", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe("ok");
  });
});

describe("E2E: streaming correctness (this session's fixes)", () => {
  it("EP-10 each streamed Anthropic response gets a UNIQUE message id (no dedupe-to-first)", async () => {
    const { worker } = wired(ok);
    const send = () => request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const idOf = (text: string) => frames(text).find((f) => f.event === "message_start")!.data.message.id as string;
    const [a, b] = await Promise.all([send(), send()]);
    const idA = idOf(a.text), idB = idOf(b.text);
    expect(idA).toMatch(/^msg_/);
    expect(idA).not.toBe(idB);
  });

  it("EP-11 message_start carries a non-zero input_tokens estimate (context bar not stuck at 0)", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "a moderately long prompt here" }] });
    const start = frames(res.text).find((f) => f.event === "message_start");
    expect(start!.data.message.usage.input_tokens).toBeGreaterThan(0);
  });

  it("EP-12 message_delta reports real usage (input minus cached, output, cache_read)", async () => {
    const usageProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 100, completionTokens: 7 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "ok", done: false };
        yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 7, cachedTokens: 30 } };
      },
    };
    const { worker } = wired(usageProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    const delta = frames(res.text).find((f) => f.event === "message_delta");
    expect(delta!.data.usage.input_tokens).toBe(70);
    expect(delta!.data.usage.output_tokens).toBe(7);
    expect(delta!.data.usage.cache_read_input_tokens).toBe(30);
  });

  it("EP-13 OpenAI stream emits a usage chunk before [DONE]", async () => {
    const usageProvider: ProviderAdapter = {
      name: "copilot",
      complete: async () => ({ id: "c1", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 9, completionTokens: 2 } }),
      async *stream(): AsyncIterable<CanonicalChunk> {
        yield { kind: "text", delta: "ok", done: false };
        yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 9, completionTokens: 2 } };
      },
    };
    const { worker } = wired(usageProvider);
    const res = await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("data: [DONE]");
    const usageChunk = openaiChunks(res.text).find((c) => c.usage);
    expect(usageChunk.usage.total_tokens).toBe(11);
  });

  it("EP-14 a mid-stream OpenAI failure emits an error chunk, not a silent close", async () => {
    const { worker } = wired(failing);
    const res = await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("context_length_exceeded");
    expect(res.text).toContain('"error"');
  });

  it("EP-14b an expired token (401) surfaces a /login hint in the error body", async () => {
    const authFail: ProviderAdapter = {
      name: "copilot",
      complete: async () => { throw new CopilotAuthError(401); },
      async *stream(): AsyncIterable<CanonicalChunk> { throw new CopilotAuthError(401); },
    };
    const { worker } = wired(authFail);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/\/login/);
  });
});
