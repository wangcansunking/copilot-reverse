import type { MetricSample } from "../../shared/control-types.js";

export interface ModelRow { model: string; count: number; avgMs: number; tokensIn: number; tokensOut: number; costUsd: number }
export interface Aggregate { total: number; errors: number; tokensIn: number; tokensOut: number; costUsd: number; byModel: ModelRow[] }

// A request "failed" if it returned a 4xx/5xx OR carried an error message — runaway streams finish
// 200 but tag an error (model degenerated, cut early), and those are exactly what we want to surface.
const isError = (s: MetricSample): boolean => s.status >= 400 || s.error != null;

// Indicative $/1M-token list prices (in, out) used ONLY to estimate spend — Copilot is flat-fee, so
// this is "what these tokens would cost at provider list price", not a real bill. Matched by substring;
// unknown models fall back to a mid GPT-4o-class rate. Update as needed; precision isn't the point.
const PRICING: { match: string; in: number; out: number }[] = [
  { match: "opus", in: 15, out: 75 },
  { match: "sonnet", in: 3, out: 15 },
  { match: "haiku", in: 0.8, out: 4 },
  { match: "gpt-5", in: 1.25, out: 10 },
  { match: "gpt-4o-mini", in: 0.15, out: 0.6 },
  { match: "gpt-4o", in: 2.5, out: 10 },
  { match: "o1", in: 15, out: 60 },
];
const RATE_FALLBACK = { in: 2.5, out: 10 };
const rate = (model: string) => PRICING.find((p) => model.toLowerCase().includes(p.match)) ?? RATE_FALLBACK;
export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const r = rate(model);
  return (tokensIn * r.in + tokensOut * r.out) / 1_000_000;
}

export function aggregate(samples: MetricSample[]): Aggregate {
  const map = new Map<string, { count: number; sum: number; tin: number; tout: number }>();
  let errors = 0;
  for (const s of samples) {
    if (isError(s)) errors++;
    const m = map.get(s.model) ?? { count: 0, sum: 0, tin: 0, tout: 0 };
    m.count++; m.sum += s.latencyMs; m.tin += s.tokensIn ?? 0; m.tout += s.tokensOut ?? 0;
    map.set(s.model, m);
  }
  const byModel = [...map.entries()].map(([model, v]) => ({
    model, count: v.count, avgMs: Math.round(v.sum / v.count),
    tokensIn: v.tin, tokensOut: v.tout, costUsd: estimateCost(model, v.tin, v.tout),
  }));
  return {
    total: samples.length, errors,
    tokensIn: byModel.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: byModel.reduce((n, r) => n + r.tokensOut, 0),
    costUsd: byModel.reduce((n, r) => n + r.costUsd, 0),
    byModel,
  };
}

// The failed requests (status >= 400 or any tagged error), newest-first, capped at `limit`. This is
// the actually-useful "log" — what failed and why — as opposed to worker restart events.
export function recentErrors(samples: MetricSample[], limit: number): MetricSample[] {
  return samples.filter(isError).slice(0, limit);
}
