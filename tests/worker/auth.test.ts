import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { AccessControl } from "../../src/worker/auth.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

// A provider that records whether it was ever invoked — proves the gate rejects BEFORE any upstream call.
function spyProvider() {
  const state = { called: false };
  const provider: ProviderAdapter = {
    name: "copilot",
    complete: async () => { state.called = true; return { id: "c1", model: "gpt-4o", content: [{ type: "text", text: "hi" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
    async *stream() { state.called = true; yield { kind: "done", done: true, finishReason: "stop" } as const; },
  };
  return { provider, state };
}

const appWith = (access: AccessControl) => {
  const { provider, state } = spyProvider();
  return { app: createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {}, undefined, access), state };
};
const ctl = (mode: "localhost" | "lan", key: string | null, exposed = false): AccessControl => ({ mode: () => mode, key: () => key, exposed });
const body = { model: "x", messages: [{ role: "user", content: "hi" }] };

describe("worker access-mode auth", () => {
  it("localhost mode serves unauthenticated (behavior unchanged from before access modes)", async () => {
    const { app, state } = appWith(ctl("localhost", null));
    const res = await request(app).post("/openai/chat/completions").send(body);
    expect(res.status).toBe(200);
    expect(state.called).toBe(true);
  });

  it("localhost mode ignores a key even when one is set", async () => {
    const { app } = appWith(ctl("localhost", "secret"));
    expect((await request(app).post("/openai/chat/completions").send(body)).status).toBe(200);
  });

  it("lan mode rejects a request with NO key (401) before any upstream call", async () => {
    const { app, state } = appWith(ctl("lan", "secret"));
    const res = await request(app).post("/openai/chat/completions").send(body);
    expect(res.status).toBe(401);
    expect(state.called).toBe(false); // never reached the provider
  });

  it("lan mode rejects an INVALID key (401)", async () => {
    const { app, state } = appWith(ctl("lan", "secret"));
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer wrong").send(body);
    expect(res.status).toBe(401);
    expect(state.called).toBe(false);
  });

  it("lan mode accepts a valid key via Authorization: Bearer (OpenAI/Codex clients)", async () => {
    const { app, state } = appWith(ctl("lan", "secret"));
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer secret").send(body);
    expect(res.status).toBe(200);
    expect(state.called).toBe(true);
  });

  it("lan mode accepts a valid key via x-api-key (Anthropic/Claude Code clients)", async () => {
    const { app } = appWith(ctl("lan", "secret"));
    const res = await request(app).post("/anthropic/v1/messages").set("x-api-key", "secret").send({ ...body, max_tokens: 8 });
    expect(res.status).toBe(200);
  });

  it("lan mode is FAIL-CLOSED: no key configured → 503, never served", async () => {
    const { app, state } = appWith(ctl("lan", null));
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer anything").send(body);
    expect(res.status).toBe(503);
    expect(state.called).toBe(false);
  });

  it("lan mode leaves /healthz OPEN (supervisor readiness probe must work behind the gate)", async () => {
    const { app } = appWith(ctl("lan", "secret"));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // Defense-in-depth for the lan→localhost switch: a worker bound to a non-loopback interface keeps
  // enforcing the key even after the mode file flips to "localhost", until the supervisor restarts it
  // onto loopback. Without this, the still-exposed 0.0.0.0 socket would briefly serve unauthenticated.
  it("an EXPOSED worker requires a key even when the mode reads localhost (no fail-open window)", async () => {
    const { app, state } = appWith(ctl("localhost", "secret", /* exposed */ true));
    const noKey = await request(app).post("/openai/chat/completions").send(body);
    expect(noKey.status).toBe(401);
    expect(state.called).toBe(false);
    const withKey = await request(app).post("/openai/chat/completions").set("authorization", "Bearer secret").send(body);
    expect(withKey.status).toBe(200);
  });

  it("an EXPOSED worker with no key configured is fail-closed (503) regardless of mode", async () => {
    const { app } = appWith(ctl("localhost", null, /* exposed */ true));
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer x").send(body);
    expect(res.status).toBe(503);
  });
});
