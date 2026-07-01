// E2E: model resolution (fuzzy dated ids, [1m] suffix strip) + vision passthrough.
// Case catalog: cases.md. Shared harness: helpers.ts.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { ok, wired } from "./helpers.js";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import { openDb, recordRequest, recentRequests } from "../src/supervisor/db.js";
import type { ProviderAdapter } from "../src/providers/types.js";

describe("E2E: model resolution & 1M", () => {
  it("EP-15 fuzzy-matches a dated Anthropic id to the Copilot model", async () => {
    const db = openDb(":memory:");
    const router = new Router([ok], {});
    router.setAvailableModels(["claude-opus-4.8", "gpt-4o"]);
    const worker = createWorkerApp(router, (m) => recordRequest(db, { ts: Date.now(), ...m }));
    await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8-20251101", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(recentRequests(db, 1)[0].model).toBe("claude-opus-4.8");
  });

  it("EP-16 strips Claude Code's [1m] suffix before forwarding", async () => {
    const db = openDb(":memory:");
    const router = new Router([ok], {});
    router.setAvailableModels(["claude-opus-4.8"]);
    const worker = createWorkerApp(router, (m) => recordRequest(db, { ts: Date.now(), ...m }));
    await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4.8[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(recentRequests(db, 1)[0].model).toBe("claude-opus-4.8");
  });
});

describe("E2E: vision", () => {
  it("EP-17 an Anthropic image block round-trips through the proxy as image content", async () => {
    let seenContent: any;
    const visionProvider: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seenContent = req.messages[0].content; return { id: "c1", model: "m", content: [{ type: "text", text: "a cat" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    const { worker } = wired(visionProvider);
    const res = await request(worker).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
    });
    expect(res.status).toBe(200);
    expect(seenContent.some((b: any) => b.type === "image" && b.dataUrl === "data:image/png;base64,AAAA")).toBe(true);
  });
});
