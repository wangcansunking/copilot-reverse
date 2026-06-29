import type { DoctorCheck, WorkerState } from "../shared/control-types.js";
import type { WebSearchBackend } from "../shared/webiq-key.js";

// Result of pinging one model through the worker proxy: did a minimal real request come back?
export interface ModelPing { model: string; ok: boolean; latencyMs?: number; error?: string }

// Injected probes so buildDoctorChecks stays pure + unit-testable (no token, no network, no fs here).
// index.ts wires these to the real heartbeat classifier, worker state, web-backend resolver, the
// worker /models endpoint, the client config files, and a real proxy ping.
export interface DoctorProbes {
  // `live` is true only on the on-demand /doctor (ping) run: do a fresh token exchange. On the light
  // path (the 2s dashboard poll) it's false — return the heartbeat's CACHED status so we don't fire a
  // real GitHub token exchange every 2s and trip GitHub's rate limit (the whole reason the heartbeat
  // runs on a 60s cadence).
  githubAuth: (live: boolean) => Promise<{ ok: boolean; detail: string }>;
  workerState: () => WorkerState;
  webBackend: () => WebSearchBackend;
  listModels: () => Promise<string[]>;        // advertised model ids (from the worker /models endpoint)
  configuredModels: () => string[];           // distinct models the clients are actually set to use
  pingModel: (model: string) => Promise<ModelPing>;
}

export interface DoctorOpts { ping?: boolean }

const webDetail: Record<WebSearchBackend, { ok: boolean; detail: string }> = {
  webiq: { ok: true, detail: "✓ via WebIQ" },
  copilot: { ok: true, detail: "✓ via Copilot (native)" },
  unavailable: { ok: false, detail: "unavailable — run /webiq to enable web search" },
};

// A user self-check. Light mode (default) is cheap and safe to poll: GitHub auth, worker liveness,
// the resolved web-search backend, and model discovery — no upstream model calls. Ping mode adds one
// real 1-token request per client-configured model so the user can confirm end-to-end reachability;
// it costs a little latency + quota, so only the on-demand /doctor triggers it (never the 2s dashboard
// poll). Every probe is defensively caught: /doctor must never throw — a failed probe is a failed
// check with its message, which is the whole point of a diagnostic.
export async function buildDoctorChecks(p: DoctorProbes, opts: DoctorOpts = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const auth = await p.githubAuth(opts.ping ?? false).catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
  checks.push({ name: "github-auth", ok: auth.ok, detail: auth.detail });

  const state = p.workerState();
  checks.push({ name: "worker", ok: state === "ready", detail: `worker is ${state}` });

  const web = webDetail[p.webBackend()];
  checks.push({ name: "web-search", ok: web.ok, detail: web.detail });

  try {
    const ids = await p.listModels();
    checks.push({ name: "models", ok: ids.length > 0, detail: ids.length ? `${ids.length} models advertised` : "no models advertised — discovery failed" });
  } catch (e) {
    checks.push({ name: "models", ok: false, detail: `model discovery failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  if (opts.ping) {
    const models = p.configuredModels();
    if (!models.length) {
      checks.push({ name: "models-ping", ok: true, detail: "no client configured — run /setup-claude or /setup-codex to enable a connectivity check" });
    } else {
      // Ping concurrently — the user is waiting on /doctor and these are independent.
      const pings = await Promise.all(models.map((m) =>
        p.pingModel(m).catch((e) => ({ model: m, ok: false, error: e instanceof Error ? e.message : String(e) } as ModelPing))));
      for (const r of pings) {
        checks.push({
          name: `model:${r.model}`, ok: r.ok,
          detail: r.ok ? `reachable${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ""}` : `unreachable — ${r.error ?? "(no message)"}`,
        });
      }
    }
  }

  return checks;
}
