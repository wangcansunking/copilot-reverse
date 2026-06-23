import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = () => createWorkerApp(new Router([provider], { "claude-opus-4-8": "gpt-4o", "*": "gpt-4o" }), () => {});

describe("M1 proxy smoke", () => {
  it("OpenAI endpoint", async () => {
    const r = await request(app()).post("/openai/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(r.body.choices[0].message.content).toBe("ok");
  });
  it("Anthropic endpoint remaps model", async () => {
    const r = await request(app()).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
    expect(r.body.content[0].text).toBe("ok");
    expect(r.body.model).toBe("gpt-4o"); // remapped before reaching the provider
  });
});
