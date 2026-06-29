import { describe, it, expect, vi } from "vitest";
import { buildActions } from "../../src/tui/assistant/tools.js";

function client() {
  return {
    status: vi.fn(async () => ({ workerState: "ready", restarts: [] })),
    restart: vi.fn(async () => {}),
    doctor: vi.fn(async () => [{ name: "github-auth", ok: true, detail: "ok" }]),
    requests: vi.fn(async () => []),
  };
}

describe("assistant actions", () => {
  it("get_status returns worker state text", async () => {
    const a = buildActions(client() as any);
    expect(await a.get_status({})).toMatch(/ready/);
  });
  it("restart_worker calls client and confirms", async () => {
    const c = client();
    const a = buildActions(c as any);
    expect(await a.restart_worker({})).toMatch(/restart/i);
    expect(c.restart).toHaveBeenCalled();
  });
  it("run_doctor summarizes checks", async () => {
    const a = buildActions(client() as any);
    expect(await a.run_doctor({})).toMatch(/github-auth/);
  });
  it("recent_errors surfaces runaway/error rows, green when none", async () => {
    const a = buildActions(client() as any);
    expect(await a.recent_errors({})).toMatch(/green/);
    const withErr = buildActions({ ...client(), requests: vi.fn(async () => [{ ts: 1, endpoint: "/v1/messages", model: "claude-opus-4.8", status: 200, latencyMs: 99, error: "runaway stream cut (repetition)" }]) } as any);
    expect(await withErr.recent_errors({})).toMatch(/runaway/);
  });
  it("metrics reports totals and per-model latency", async () => {
    const c = buildActions({ ...client(), requests: vi.fn(async () => [{ ts: 1, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 20 }]) } as any);
    expect(await c.metrics({})).toMatch(/requests: 1/);
  });
});
