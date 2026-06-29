import type { DaemonClient } from "../daemon-client.js";
import { aggregate, recentErrors } from "../panels/metrics-agg.js";

// Plain action handlers — wrapped as SDK tools in runtime.ts.
// Each takes a parsed-args object and returns a short text result for the model.
export function buildActions(client: Pick<DaemonClient, "status" | "restart" | "doctor" | "requests">) {
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
      const errs = recentErrors(await client.requests(), 10);
      if (!errs.length) return "no request errors logged — everything's green";
      return errs.map((e) => `${e.status} ${e.endpoint} ${e.model} — ${e.error ?? "(no message)"}`).join("; ");
    },
    async metrics(_args: Record<string, never>): Promise<string> {
      const a = aggregate(await client.requests());
      if (!a.total) return "no requests yet";
      return `requests: ${a.total}, errors: ${a.errors}; ` + a.byModel.map((r) => `${r.model} n=${r.count} avg=${r.avgMs}ms`).join("; ");
    },
  };
}
export type AssistantActions = ReturnType<typeof buildActions>;
