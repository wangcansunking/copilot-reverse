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
import { createControlApp } from "../src/supervisor/api.js";
import { openDb, recordRequest } from "../src/supervisor/db.js";
import { buildRegistry } from "../src/tui/slash/commands.js";
import { applyClaude, resetClaude, CLAUDE_ENV_KEYS } from "../src/tui/setup/apply.js";
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
  const control = createControlApp({ db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [{ name: "worker", ok: true, detail: "ready" }], subscribe: () => () => {} });
  return { worker, control };
}

describe("E2E: proxy", () => {
  it("EP-01 Anthropic streaming yields message_start..delta..message_stop", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("message_start");
    expect(res.text).toContain('"text":"ok"');
    expect(res.text).toContain("message_stop");
  });

  it("EP-02 OpenAI completion returns assistant content", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/v1/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.body.choices[0].message.content).toBe("ok");
  });

  it("EP-03 count_tokens returns a positive estimate", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/v1/messages/count_tokens").send({ model: "claude-opus-4-8", messages: [{ role: "user", content: "count me" }] });
    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  it("EP-04 a request carrying an Anthropic server-side tool still completes (no hang)", async () => {
    const { worker } = wired(ok);
    const res = await request(worker).post("/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe("ok");
  });
});

describe("E2E: error capture & dashboard", () => {
  it("EP-05 a failed stream surfaces an error frame AND lands in the control API + dashboard data", async () => {
    const { worker, control } = wired(failing);
    const res = await request(worker).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
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
