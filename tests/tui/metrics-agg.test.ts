import { describe, it, expect } from "vitest";
import { aggregate, recentErrors } from "../../src/tui/panels/metrics-agg.js";
import type { MetricSample } from "../../src/shared/control-types.js";

const s = (model: string, status: number, ms: number): MetricSample => ({ ts: 0, endpoint: "/v1/chat/completions", model, status, latencyMs: ms });

describe("metrics aggregate", () => {
  it("counts, errors, and avg latency per model", () => {
    const a = aggregate([s("gpt-4o", 200, 10), s("gpt-4o", 200, 30), s("gpt-4o", 502, 5)]);
    expect(a.total).toBe(3);
    expect(a.errors).toBe(1);
    const row = a.byModel.find((r) => r.model === "gpt-4o")!;
    expect(row.count).toBe(3);
    expect(row.avgMs).toBe(15);
  });

  it("recentErrors keeps only failed requests with their messages, preserving order, capped", () => {
    const samples: MetricSample[] = [
      { ts: 3, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 5, error: "context_length_exceeded" },
      { ts: 2, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 10 },
      { ts: 1, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 401, latencyMs: 3, error: "authentication_error: token expired" },
    ];
    const errs = recentErrors(samples, 10);
    expect(errs.map((e) => e.status)).toEqual([502, 401]);
    expect(errs[0].error).toMatch(/context_length_exceeded/);
    expect(recentErrors(samples, 1)).toHaveLength(1);
  });

  it("treats a 200-but-tagged turn (runaway cut) as an error so it gets reported", () => {
    const samples: MetricSample[] = [
      { ts: 2, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 200, latencyMs: 120000, error: "runaway stream cut (repetition)" },
      { ts: 1, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 10 },
    ];
    expect(aggregate(samples).errors).toBe(1);
    expect(recentErrors(samples, 10).map((e) => e.error)).toEqual(["runaway stream cut (repetition)"]);
  });
});
