import { describe, it, expect, vi } from "vitest";
import { buildDoctorChecks, type DoctorProbes } from "../../src/supervisor/doctor.js";

// A probe set where everything is healthy; tests override individual fields.
function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    githubAuth: async () => ({ ok: true, detail: "token valid" }),
    workerState: () => "ready",
    webBackend: () => "webiq",
    listModels: async () => ["gpt-4o", "claude-opus-4-8"],
    configuredModels: () => ["claude-opus-4-8"],
    pingModel: async (m) => ({ model: m, ok: true, latencyMs: 12 }),
    ...over,
  };
}

const find = (cs: { name: string }[], name: string) => cs.find((c) => c.name === name);

describe("buildDoctorChecks (light)", () => {
  it("reports github, worker, web search, and model discovery without any model ping", async () => {
    const pingModel = vi.fn(async (m: string) => ({ model: m, ok: true, latencyMs: 1 }));
    const checks = await buildDoctorChecks(probes({ pingModel }), { ping: false });
    expect(find(checks, "github-auth")?.ok).toBe(true);
    expect(find(checks, "worker")?.ok).toBe(true);
    expect(find(checks, "web-search")?.ok).toBe(true);
    expect(find(checks, "web-search")?.detail).toMatch(/webiq/i);
    expect(find(checks, "models")?.ok).toBe(true);
    expect(find(checks, "models")?.detail).toMatch(/2/); // advertised count
    expect(pingModel).not.toHaveBeenCalled(); // light mode never touches upstream models
  });

  it("flags web search unavailable as not-ok with a /webiq hint", async () => {
    const checks = await buildDoctorChecks(probes({ webBackend: () => "unavailable" }), { ping: false });
    const web = find(checks, "web-search");
    expect(web?.ok).toBe(false);
    expect(web?.detail).toMatch(/webiq/i);
  });

  it("fails the models check when discovery returns nothing", async () => {
    const checks = await buildDoctorChecks(probes({ listModels: async () => [] }), { ping: false });
    expect(find(checks, "models")?.ok).toBe(false);
  });

  it("surfaces a model-discovery error as a failed check, not a throw", async () => {
    const checks = await buildDoctorChecks(probes({ listModels: async () => { throw new Error("worker down"); } }), { ping: false });
    expect(find(checks, "models")?.ok).toBe(false);
    expect(find(checks, "models")?.detail).toMatch(/worker down/);
  });

  it("asks githubAuth for the CACHED result on the light path (live=false), not a fresh probe", async () => {
    const githubAuth = vi.fn(async (_live: boolean) => ({ ok: true, detail: "cached" }));
    await buildDoctorChecks(probes({ githubAuth }), { ping: false });
    expect(githubAuth).toHaveBeenCalledWith(false); // light = reuse heartbeat cache, no token exchange
  });
});

describe("buildDoctorChecks (ping)", () => {
  it("does a LIVE github probe on the ping path (live=true)", async () => {
    const githubAuth = vi.fn(async (_live: boolean) => ({ ok: true, detail: "live" }));
    await buildDoctorChecks(probes({ githubAuth }), { ping: true });
    expect(githubAuth).toHaveBeenCalledWith(true); // on-demand /doctor → authoritative fresh exchange
  });

  it("adds one check per configured model, reporting latency", async () => {
    const checks = await buildDoctorChecks(probes({ configuredModels: () => ["claude-opus-4-8", "gpt-4o"] }), { ping: true });
    expect(find(checks, "model:claude-opus-4-8")?.ok).toBe(true);
    expect(find(checks, "model:claude-opus-4-8")?.detail).toMatch(/12ms|ms/);
    expect(find(checks, "model:gpt-4o")?.ok).toBe(true);
  });

  it("reports a failing model ping as a failed check with its error", async () => {
    const checks = await buildDoctorChecks(
      probes({ pingModel: async (m) => ({ model: m, ok: false, error: "502 bad gateway" }) }),
      { ping: true },
    );
    const c = find(checks, "model:claude-opus-4-8");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toMatch(/502/);
  });

  it("notes when no clients are configured (nothing to ping)", async () => {
    const checks = await buildDoctorChecks(probes({ configuredModels: () => [] }), { ping: true });
    // No model:* checks; a single informational note instead.
    expect(checks.some((c) => c.name.startsWith("model:"))).toBe(false);
    expect(find(checks, "models-ping")?.detail).toMatch(/no client/i);
  });
});
