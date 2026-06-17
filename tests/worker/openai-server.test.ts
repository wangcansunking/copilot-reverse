import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "c1", model: "gpt-4o", content: [{ type: "text", text: "hello" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "he", done: false } as const; yield { kind: "text", delta: "llo", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = () => createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {});

describe("worker OpenAI endpoint", () => {
  it("non-stream completion", async () => {
    const res = await request(app()).post("/v1/chat/completions").send({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("hello");
  });
  it("SSE stream", async () => {
    const res = await request(app()).post("/v1/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain('"content":"he"');
    expect(res.text).toContain("data: [DONE]");
  });
});
