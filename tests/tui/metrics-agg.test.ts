import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/tui/panels/metrics-agg.js";
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
});
