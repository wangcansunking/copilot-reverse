import type { MetricSample } from "../../shared/control-types.js";

export interface ModelRow { model: string; count: number; avgMs: number }
export interface Aggregate { total: number; errors: number; byModel: ModelRow[] }

// A request "failed" if it returned a 4xx/5xx OR carried an error message — runaway streams finish
// 200 but tag an error (model degenerated, cut early), and those are exactly what we want to surface.
const isError = (s: MetricSample): boolean => s.status >= 400 || s.error != null;

export function aggregate(samples: MetricSample[]): Aggregate {
  const map = new Map<string, { count: number; sum: number }>();
  let errors = 0;
  for (const s of samples) {
    if (isError(s)) errors++;
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

// The failed requests (status >= 400 or any tagged error), newest-first, capped at `limit`. This is
// the actually-useful "log" — what failed and why — as opposed to worker restart events.
export function recentErrors(samples: MetricSample[], limit: number): MetricSample[] {
  return samples.filter(isError).slice(0, limit);
}
