// End-to-end suite — exercises the real worker + supervisor + slash modules wired together
// the way production wires them (worker metric sink -> supervisor db -> control API), with a
// fake Copilot provider so no live network is touched. Every code update must keep these green.
//
// Case catalog and latest results live next to this file: see cases.md and RESULTS.md.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import { CopilotAuthError } from "../src/providers/copilot/token.js";
import { createControlApp } from "../src/supervisor/api.js";
import { openDb, recordRequest, recentRequests } from "../src/supervisor/db.js";
import { buildRegistry } from "../src/tui/slash/commands.js";
import { applyClaude, resetClaude, CLAUDE_ENV_KEYS } from "../src/tui/setup/apply.js";
import { claudeCopilotReverseEnv } from "../src/tui/setup/clients.js";
import { readClientStatus } from "../src/tui/setup/status.js";
import { applyCodexToml, codexTomlPath } from "../src/tui/setup/codex-toml.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { CanonicalChunk } from "../src/core/canonical.js";

const ok: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const failing: ProviderAdapter = {
  name: "copilot",
  complete: async () => { throw new Error("context_length_exceeded"); },
  async *stream(): AsyncIterable<CanonicalChunk> {
    yield { kind: "text", delta: "partial", done: false };
    throw new Error("context_length_exceeded: prompt too long");
  },
};

// Wire a worker app to a supervisor db exactly like the daemon does (metric -> recordRequest).
function wired(provider: ProviderAdapter) {
  const db = openDb(":memory:");
  const worker = createWorkerApp(new Router([provider], { "*": "gpt-4o" }), (m) => recordRequest(db, { ts: Date.now(), ...m }));
  const control = createControlApp({ db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [{ name: "worker", ok: true, detail: "ready" }], github: () => undefined, subscribe: () => () => {} });
  return { worker, control, db };
}

// Parse an SSE body into ordered { event, data } frames (Anthropic) — shared by streaming cases.
function frames(body: string): { event: string; data: any }[] {
  return body.split("\n\n").map((b) => b.trim()).filter(Boolean).map((b) => ({
    event: b.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "",
    data: JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}"),
  }));
}
// Parse OpenAI `data: {json}` SSE lines (skips [DONE]).
function openaiChunks(body: string): any[] {
  return body.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))?.slice(6)).filter((d): d is string => !!d && d.trim() !== "[DONE]").map((d) => JSON.parse(d));
}

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

describe("E2E: persistence & control API", () => {
  it("EP-21 a failed request's error message persists in the request_log and is queryable", async () => {
    const { worker, control } = wired(failing);
    await request(worker).post("/openai/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const res = await request(control).get("/api/requests");
    const failed = res.body.requests.find((r: any) => r.status >= 400);
    expect(failed.error).toMatch(/context_length_exceeded/);
  });

  it("EP-22 control API exposes status, doctor, and requests endpoints", async () => {
    const { control } = wired(ok);
    expect((await request(control).get("/api/status")).body.workerState).toBe("ready");
    expect((await request(control).get("/api/doctor")).body.checks[0].name).toBe("worker");
    expect(Array.isArray((await request(control).get("/api/requests")).body.requests)).toBe(true);
  });

  it("EP-23 db migration: a freshly opened db round-trips a recorded request", async () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1, endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 5 });
    expect(recentRequests(db, 1)[0].status).toBe(200);
  });
});

describe("E2E: setup lifecycle (Claude + Codex)", () => {
  it("EP-24 setup writes Claude config the HUD status then reports as configured (user scope)", async () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "e2e-cwd-"));
    applyClaude("global", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000), { home, cwd });
    const status = readClientStatus({ home, cwd });
    expect(status.claude.user).toBe(true);
    expect(status.claude.project).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.env.ANTHROPIC_MODEL).toBe("claude-opus-4.8[1m]");
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
  });

  it("EP-25 setup-codex writes a native config.toml with the model context window", () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-codex-"));
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7891/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    const toml = readFileSync(codexTomlPath(home), "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain("model_context_window = 1050000");
    expect(toml).toContain("[model_providers.copilot-reverse]");
  });

  it("EP-26 reset removes every key setup wrote, including the 1M-window keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-reset2-"));
    applyClaude("project", claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000), { cwd });
    resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});



describe("E2E: error capture & dashboard", () => {
  it("EP-05 a failed stream surfaces an error frame AND lands in the control API + dashboard data", async () => {
    const { worker, control } = wired(failing);
    const res = await request(worker).post("/anthropic/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("event: error");
    expect(res.text).toContain("context_length_exceeded");
    // the supervisor recorded the failure with its message
    const reqs = await request(control).get("/api/requests");
    const failed = reqs.body.requests.find((r: any) => r.status >= 400);
    expect(failed).toBeDefined();
    expect(failed.error).toMatch(/context_length_exceeded/);
  });

  it("EP-06 the supervisor serves the dashboard HTML at /", async () => {
    const { control } = wired(ok);
    const res = await request(control).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});

describe("E2E: TUI commands", () => {
  const ctx = () => ({
    client: {
      status: async () => ({ workerState: "ready" as const, restarts: [] }),
      restart: async () => {}, stop: async () => {}, start: async () => {},
      doctor: async () => [{ name: "worker", ok: true, detail: "ready" }],
      requests: async () => [{ ts: 1, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 4, error: "context_length_exceeded" }],
    },
    quit: () => {},
  });
  const endpoint = { host: "127.0.0.1", port: 7891, apiKey: "k" };

  it("EP-07 /logs surfaces recent request errors with their messages", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/logs");
    expect(out.join("\n")).toMatch(/context_length_exceeded/);
  });

  it("EP-08 /dashboard and /report open URLs in the browser", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { dashboardUrl: "http://127.0.0.1:7890/", reportRepo: "octo/copilot-reverse", appVersion: "0.0.1", openUrl: (u) => opened.push(u) });
    await reg.run("/dashboard");
    await reg.run("/report");
    expect(opened[0]).toBe("http://127.0.0.1:7890/");
    expect(opened[1]).toMatch(/^https:\/\/github\.com\/octo\/copilot-reverse\/issues\/new\?/);
  });

  it("EP-09 /reset removes the keys that setup wrote (round-trip)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "e2e-reset-"));
    applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "gpt-4o" }, { cwd });
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async () => resetClaude("project", CLAUDE_ENV_KEYS, { cwd }).changed });
    const out = await reg.run("/reset-claude");
    expect(out.join("\n")).toMatch(/ANTHROPIC_BASE_URL/);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
