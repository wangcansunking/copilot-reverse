import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import { isLoopbackAddr, type AccessControl } from "../../src/worker/auth.js";
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

const appWith = (access: AccessControl, isLocal?: (req: { socket: { remoteAddress?: string } }) => boolean) => {
  const { provider, state } = spyProvider();
  return { app: createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {}, undefined, access, isLocal), state };
};
const ctl = (mode: "localhost" | "lan", key: string | null, exposed = false): AccessControl => ({ mode: () => mode, key: () => key, exposed });
const body = { model: "x", messages: [{ role: "user", content: "hi" }] };
// supertest drives over loopback, so by default every request reads as local. These injectors let a
// test pin the perceived origin: REMOTE simulates an off-box caller (the one that must present a key),
// LOCAL is explicit loopback.
const REMOTE = () => false;
const LOCAL = () => true;

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

  it("lan mode rejects a REMOTE request with NO key (401) before any upstream call", async () => {
    const { app, state } = appWith(ctl("lan", "secret"), REMOTE);
    const res = await request(app).post("/openai/chat/completions").send(body);
    expect(res.status).toBe(401);
    expect(state.called).toBe(false); // never reached the provider
  });

  it("lan mode rejects a REMOTE INVALID key (401)", async () => {
    const { app, state } = appWith(ctl("lan", "secret"), REMOTE);
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer wrong").send(body);
    expect(res.status).toBe(401);
    expect(state.called).toBe(false);
  });

  it("lan mode rejects a REMOTE SAME-LENGTH wrong key (exercises timingSafeEqual, not just the length check)", async () => {
    // "secret" vs "sekret" are equal length, so the length short-circuit in keysMatch can't reject —
    // only the constant-time compare can. Guards against an always-true compare passing the suite.
    const { app, state } = appWith(ctl("lan", "secret"), REMOTE);
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer sekret").send(body);
    expect(res.status).toBe(401);
    expect(state.called).toBe(false);
  });

  it("lan mode accepts a REMOTE valid key via Authorization: Bearer (OpenAI/Codex clients)", async () => {
    const { app, state } = appWith(ctl("lan", "secret"), REMOTE);
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer secret").send(body);
    expect(res.status).toBe(200);
    expect(state.called).toBe(true);
  });

  it("lan mode accepts a REMOTE valid key via x-api-key (Anthropic/Claude Code clients)", async () => {
    const { app } = appWith(ctl("lan", "secret"), REMOTE);
    const res = await request(app).post("/anthropic/v1/messages").set("x-api-key", "secret").send({ ...body, max_tokens: 8 });
    expect(res.status).toBe(200);
  });

  // The behavior the user asked for: in LAN mode the local machine's own clients keep working WITHOUT a
  // key — only genuinely remote callers are challenged. The loopback decision is TCP-layer only.
  it("lan mode serves a LOOPBACK request WITHOUT a key (local Claude/Codex unaffected by LAN)", async () => {
    const { app, state } = appWith(ctl("lan", "secret"), LOCAL);
    const res = await request(app).post("/openai/chat/completions").send(body);
    expect(res.status).toBe(200);
    expect(state.called).toBe(true);
  });

  it("lan mode does NOT require a key from loopback even when none is configured (local stays open)", async () => {
    const { app } = appWith(ctl("lan", null), LOCAL);
    expect((await request(app).post("/openai/chat/completions").send(body)).status).toBe(200);
  });

  it("lan mode is FAIL-CLOSED for REMOTE: no key configured → 503, never served", async () => {
    const { app, state } = appWith(ctl("lan", null), REMOTE);
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer anything").send(body);
    expect(res.status).toBe(503);
    expect(state.called).toBe(false);
  });

  it("lan mode leaves /healthz OPEN even for a remote probe (supervisor readiness)", async () => {
    const { app } = appWith(ctl("lan", "secret"), REMOTE);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // Defense-in-depth for the lan→localhost switch: a worker bound to a non-loopback interface keeps
  // enforcing the key for REMOTE callers even after the mode file flips to "localhost", until the
  // supervisor restarts it onto loopback. Without this, the still-exposed 0.0.0.0 socket would briefly
  // serve unauthenticated to the network. Loopback callers are still exempt throughout.
  it("an EXPOSED worker requires a key from REMOTE even when the mode reads localhost (no fail-open window)", async () => {
    const { app, state } = appWith(ctl("localhost", "secret", /* exposed */ true), REMOTE);
    const noKey = await request(app).post("/openai/chat/completions").send(body);
    expect(noKey.status).toBe(401);
    expect(state.called).toBe(false);
    const { app: app2 } = appWith(ctl("localhost", "secret", true), REMOTE);
    const withKey = await request(app2).post("/openai/chat/completions").set("authorization", "Bearer secret").send(body);
    expect(withKey.status).toBe(200);
  });

  it("an EXPOSED worker still serves LOOPBACK without a key (only the network is gated)", async () => {
    const { app } = appWith(ctl("localhost", "secret", /* exposed */ true), LOCAL);
    expect((await request(app).post("/openai/chat/completions").send(body)).status).toBe(200);
  });

  it("an EXPOSED worker with no key configured is fail-closed (503) for REMOTE regardless of mode", async () => {
    const { app } = appWith(ctl("localhost", null, /* exposed */ true), REMOTE);
    const res = await request(app).post("/openai/chat/completions").set("authorization", "Bearer x").send(body);
    expect(res.status).toBe(503);
  });
});

describe("isLoopbackAddr (the spoof-proof loopback check)", () => {
  it("treats IPv4 127.0.0.0/8 as loopback", () => {
    expect(isLoopbackAddr("127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("127.1.2.3")).toBe(true);
  });
  it("treats IPv6 ::1 as loopback", () => {
    expect(isLoopbackAddr("::1")).toBe(true);
    expect(isLoopbackAddr("::1".toUpperCase())).toBe(true); // case-insensitive
  });
  it("treats IPv4-mapped-IPv6 loopback as loopback (the form a dual-stack 0.0.0.0 socket sees)", () => {
    expect(isLoopbackAddr("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("::FFFF:127.0.0.1")).toBe(true);
  });
  it("treats LAN / public / mapped-non-loopback addresses as NON-local", () => {
    expect(isLoopbackAddr("192.168.1.5")).toBe(false);
    expect(isLoopbackAddr("10.30.1.204")).toBe(false);
    expect(isLoopbackAddr("::ffff:192.168.1.5")).toBe(false); // mapped, but not loopback
    expect(isLoopbackAddr("8.8.8.8")).toBe(false);
    expect(isLoopbackAddr("0.0.0.0")).toBe(false);
  });
  it("fail-safe: an unknown/empty address is NON-local (a request we can't attribute is gated)", () => {
    expect(isLoopbackAddr(undefined)).toBe(false);
    expect(isLoopbackAddr("")).toBe(false);
  });
  it("does not be fooled by a hostname containing 127 (only true dotted-quad / ::1 forms)", () => {
    expect(isLoopbackAddr("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackAddr("notlocal")).toBe(false);
  });
});
