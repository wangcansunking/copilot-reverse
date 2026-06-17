import type { MetricSample } from "../../shared/control-types.js";

export interface ModelRow { model: string; count: number; avgMs: number }
export interface Aggregate { total: number; errors: number; byModel: ModelRow[] }

export function aggregate(samples: MetricSample[]): Aggregate {
  const map = new Map<string, { count: number; sum: number }>();
  let errors = 0;
  for (const s of samples) {
    if (s.status >= 400) errors++;
    const m = map.get(s.model) ?? { count: 0, sum: 0 };
    m.count++; m.sum += s.latencyMs;
    map.set(s.model, m);
  }
  return {
    total: samples.length,
    errors,
    byModel: [...map.entries()].map(([model, v]) => ({ model, count: v.count, avgMs: Math.round(v.sum / v.count) })),
  };
}
