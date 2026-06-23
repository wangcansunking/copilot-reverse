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
    const res = await request(app()).post("/openai/chat/completions").send({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("hello");
  });
  it("SSE stream", async () => {
    const res = await request(app()).post("/openai/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain('"content":"he"');
    expect(res.text).toContain("data: [DONE]");
  });
  it("each streamed response gets a unique id (clients dedupe by id)", async () => {
    const send = () => request(app()).post("/openai/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    const idOf = (text: string) => JSON.parse(text.split("\n\n").find((b) => b.startsWith("data: ") && b.includes('"id"'))!.slice(6)).id as string;
    const [a, b] = await Promise.all([send(), send()]);
    expect(idOf(a.text)).toMatch(/^chatcmpl-/);
    expect(idOf(a.text)).not.toBe(idOf(b.text));
  });
  it("returns 502 with the upstream message when the provider fails", async () => {
    const fail: ProviderAdapter = { name: "copilot", complete: async () => { throw new Error("boom: bad request"); }, async *stream() { throw new Error("x"); } };
    const res = await request(createWorkerApp(new Router([fail], { "*": "gpt-4o" }), () => {})).post("/openai/chat/completions").send({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/boom: bad request/);
  });
  it("GET /openai/models returns the model list in OpenAI list shape (fixes the connection-test 404)", async () => {
    const res = await request(app()).get("/openai/models");
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toMatchObject({ object: "model" });
    expect(typeof res.body.data[0].id).toBe("string");
  });
});
