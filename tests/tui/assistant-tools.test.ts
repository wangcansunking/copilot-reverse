import { describe, it, expect, vi } from "vitest";
import { buildActions } from "../../src/tui/assistant/tools.js";
import type { MetricsResponse, MetricSample, MetricsWindow } from "../../src/shared/control-types.js";

const emptyWindow: MetricsWindow = { total: 0, errors: 0, tokensIn: 0, tokensOut: 0, byModel: [] };
// recent_errors and metrics now read the SQL rollup via client.metrics() (not the capped requests()).
function metricsResponse(p: Partial<MetricsResponse> = {}): MetricsResponse {
  return { all: emptyWindow, day: emptyWindow, recentErrors: [], ...p };
}

function client() {
  return {
    status: vi.fn(async () => ({ workerState: "ready", restarts: [] })),
    restart: vi.fn(async () => {}),
    doctor: vi.fn(async () => [{ name: "github-auth", ok: true, detail: "ok" }]),
    requests: vi.fn(async () => []),
    metrics: vi.fn(async () => metricsResponse()),
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
  it("recent_errors surfaces runaway/error rows, green when none, and flattens multi-line messages", async () => {
    const a = buildActions(client() as any);
    // Empty-state wording matches /logs + the dashboard ("…green ✓"), not a bare "green".
    expect(await a.recent_errors({})).toBe("no request errors logged — everything's green ✓");
    // A multi-line upstream body (a 502 HTML page) must be flattened by oneLine — no newline can break
    // the "; "-joined list, the same guard /logs + /metrics + the dashboard apply.
    const err: MetricSample = { ts: 1, endpoint: "/v1/messages", model: "claude-opus-4.8", status: 502, latencyMs: 99, error: "upstream 502\n<html>\n<body>Bad Gateway</body>\n</html>" };
    const withErr = buildActions({ ...client(), metrics: vi.fn(async () => metricsResponse({ recentErrors: [err] })) } as any);
    const out = await withErr.recent_errors({});
    expect(out).toMatch(/upstream 502/);
    expect(out).not.toMatch(/\r?\n/); // flattened — no embedded newline
  });
  it("metrics reports totals, per-model latency, and shares the card's token/cost formatting", async () => {
    const all: MetricsWindow = { total: 5, errors: 1, tokensIn: 39_602_000, tokensOut: 777_000, byModel: [{ model: "gpt-4o", count: 5, errors: 1, avgMs: 20, tokensIn: 39_602_000, tokensOut: 777_000 }] };
    const c = buildActions({ ...client(), metrics: vi.fn(async () => metricsResponse({ all })) } as any);
    const out = await c.metrics({});
    expect(out).toMatch(/requests: 5/);
    // Shared fmtTokens/fmtCost — compressed "39602.0k", not the raw integer 39602000.
    expect(out).toMatch(/39602\.0k↑\/777\.0k↓/);
    expect(out).not.toMatch(/39602000/);
    expect(out).toMatch(/est\. cost: \$/);
  });
});
