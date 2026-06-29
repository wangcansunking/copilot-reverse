import type { ClientStatus } from "../tui/setup/status.js";
import { oneLine } from "../shared/format.js";
import type { ModelPing } from "./doctor.js";

// The distinct set of models the clients are ACTUALLY configured to use (across both scopes, both
// clients), de-duplicated. This is what /doctor pings — pinging every advertised model would be slow
// and pointless; the user only cares that the model(s) their tools are wired to actually answer.
export function distinctConfiguredModels(status: ClientStatus): string[] {
  const out = new Set<string>();
  for (const c of [status.claude, status.codex]) {
    if (c.user && c.userModel) out.add(c.userModel);
    if (c.project && c.projectModel) out.add(c.projectModel);
  }
  return [...out];
}

// Ping one model by sending the smallest possible real request through the worker's own Anthropic
// proxy (the same path Claude Code uses), so the check exercises the true resolution + upstream call
// rather than re-implementing token/adapter logic in the supervisor. A 200 means reachable; anything
// else (or a throw) is reported with a flattened one-line reason fit for a DoctorCheck.detail.
//
// A connectivity probe must FAIL FAST: a hung upstream would otherwise block /doctor for minutes (the
// worker's non-stream path has no deadline of its own), so we abort after `timeoutMs` and report it.
export async function pingViaProxy(
  workerBase: string,
  model: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<ModelPing> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${workerBase}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) return { model, ok: true, latencyMs };
    const body = oneLine(await res.text().catch(() => ""), 140);
    return { model, ok: false, latencyMs, error: `${res.status}${body ? ` ${body}` : ""}` };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    // An abort surfaces as an AbortError; report it as a timeout rather than a bare "aborted".
    if (e instanceof Error && e.name === "AbortError") return { model, ok: false, latencyMs, error: `timed out after ${timeoutMs}ms` };
    return { model, ok: false, latencyMs, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
