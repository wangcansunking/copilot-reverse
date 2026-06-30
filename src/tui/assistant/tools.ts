import type { DaemonClient } from "../daemon-client.js";
import { withCost, fmtTokens, fmtCost } from "../panels/metrics-agg.js";
import { oneLine } from "../../shared/format.js";

// Plain action handlers — wrapped as SDK tools in runtime.ts.
// Each takes a parsed-args object and returns a short text result for the model.
export function buildActions(client: Pick<DaemonClient, "status" | "restart" | "doctor" | "requests" | "metrics">) {
  return {
    async get_status(_args: Record<string, never>): Promise<string> {
      const s = await client.status();
      return `worker is ${s.workerState}; ${s.restarts.length} restart event(s) recorded`;
    },
    async restart_worker(_args: Record<string, never>): Promise<string> {
      await client.restart();
      return "restart requested; worker is restarting";
    },
    async run_doctor(_args: Record<string, never>): Promise<string> {
      const checks = await client.doctor();
      return checks.map((c) => `${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`).join("; ");
    },
    async recent_requests(_args: Record<string, never>): Promise<string> {
      const reqs = await client.requests();
      if (!reqs.length) return "no requests logged yet";
      return reqs.slice(0, 10).map((r) => `${r.endpoint} ${r.model} ${r.status} ${r.latencyMs}ms`).join("; ");
    },
    async recent_errors(_args: Record<string, never>): Promise<string> {
      // From the SQL error query over the whole request_log — errors past the last-100 window still show.
      // oneLine() flattens each message (a Copilot 502 can be a whole HTML page) so a newline can't break
      // the "; "-joined list — same treatment /logs, /metrics, and the dashboard give upstream errors.
      const errs = (await client.metrics()).recentErrors.slice(0, 10);
      if (!errs.length) return "no request errors logged — everything's green ✓";
      return errs.map((e) => `${e.status} ${e.endpoint} ${e.model} — ${oneLine(e.error, 160) || "(no message)"}`).join("; ");
    },
    async metrics(_args: Record<string, never>): Promise<string> {
      // Real lifetime totals over the whole request_log (not a 100-row cap), cost from list price.
      // Shared fmtTokens/fmtCost so the agent prints "39.6k↑/777.0k↓ $649.87" like the card, not raw ints.
      const a = withCost((await client.metrics()).all);
      if (!a.total) return "no requests yet";
      return `requests: ${a.total}, errors: ${a.errors}, tokens: ${fmtTokens(a.tokensIn)}↑/${fmtTokens(a.tokensOut)}↓, est. cost: ${fmtCost(a.costUsd)}; ` + a.byModel.map((r) => `${r.model} n=${r.count} avg=${r.avgMs}ms`).join("; ");
    },
  };
}
export type AssistantActions = ReturnType<typeof buildActions>;
