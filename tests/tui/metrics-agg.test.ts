import { describe, it, expect } from "vitest";
import { aggregate, recentErrors, estimateCost } from "../../src/tui/panels/metrics-agg.js";
import type { MetricSample } from "../../src/shared/control-types.js";

const s = (model: string, status: number, ms: number): MetricSample => ({ ts: 0, endpoint: "/v1/chat/completions", model, status, latencyMs: ms });
const su = (model: string, tokensIn: number, tokensOut: number): MetricSample => ({ ts: 0, endpoint: "/v1/chat/completions", model, status: 200, latencyMs: 10, tokensIn, tokensOut });

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

  it("sums tokens per model and overall, treating missing usage as zero", () => {
    const a = aggregate([su("gpt-4o", 100, 200), su("gpt-4o", 50, 50), s("gpt-4o", 200, 10)]);
    const row = a.byModel.find((r) => r.model === "gpt-4o")!;
    expect(row.tokensIn).toBe(150);
    expect(row.tokensOut).toBe(250);
    expect(a.tokensIn).toBe(150);
    expect(a.tokensOut).toBe(250);
  });

  it("estimates cost from per-model list price (opus dearer than gpt-4o-mini)", () => {
    expect(estimateCost("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 5);
    expect(estimateCost("claude-opus-4-8", 1_000_000, 0)).toBeCloseTo(15, 5);
    expect(estimateCost("unknown-model", 1_000_000, 1_000_000)).toBeCloseTo(12.5, 5); // fallback 2.5+10
    expect(aggregate([su("claude-opus-4-8", 1_000_000, 0)]).costUsd).toBeCloseTo(15, 5);
  });
});
