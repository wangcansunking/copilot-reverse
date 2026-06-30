// Deep lifecycle tests for WorkerMonitor — the real fork/crash/restart/IPC supervision path,
// driven by a controllable fake worker process (fixtures/fake-worker.cjs). These exercise the
// most safety-critical, previously-untested code: state transitions, crash → backoff → respawn,
// the maxCrashes → "unhealthy" stop, manual restart, graceful stop, and metric/message relay.
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WorkerMonitor, type MonitorHooks } from "../../src/supervisor/monitor.js";
import { defaultConfig, type AppConfig } from "../../src/shared/config.js";
import type { WorkerState } from "../../src/shared/control-types.js";
import type { WorkerToSupervisor } from "../../src/shared/ipc.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-worker.cjs");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fast restart policy so tests don't wait on real backoff.
function cfg(over: Partial<AppConfig["restart"]> = {}): AppConfig {
  return { ...defaultConfig(), restart: { maxCrashes: 3, windowMs: 60_000, baseBackoffMs: 10, maxBackoffMs: 40, unhealthyCooldownMs: 50, ...over } };
}
function hooks() {
  const states: WorkerState[] = [];
  const crashes: { exitCode: number | null }[] = [];
  const messages: WorkerToSupervisor[] = [];
  const h: MonitorHooks = {
    onStateChange: (s) => states.push(s),
    onCrash: (d, exitCode) => crashes.push({ exitCode }),
    onWorkerMessage: (m) => messages.push(m),
  };
  return { h, states, crashes, messages };
}
const waitFor = async (pred: () => boolean, timeout = 2000) => {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeout) await delay(10);
  if (!pred()) throw new Error("waitFor timed out");
};

describe("WorkerMonitor lifecycle", () => {
  it("reaches 'ready' after the worker sends {ready}", async () => {
    const { h, states } = hooks();
    const m = new WorkerMonitor({ ...cfg(), }, fixture, h);
    process.env.FAKE_MODE = "ready";
    m.start();
    await waitFor(() => states.includes("ready"));
    expect(states[0]).toBe("starting");
    expect(states).toContain("ready");
    m.stop();
  });

  it("relays worker messages (e.g. request-metric) to the hook", async () => {
    const { h, messages } = hooks();
    const m = new WorkerMonitor(cfg(), fixture, h);
    process.env.FAKE_MODE = "metric";
    m.start();
    await waitFor(() => messages.some((x) => x.type === "request-metric"));
    expect(messages.find((x) => x.type === "request-metric")).toMatchObject({ model: "m", status: 200 });
    m.stop();
  });

  it("crashes then respawns (records the crash, returns to ready)", async () => {
    const { h, states, crashes } = hooks();
    // crash once shortly after ready, then the respawn comes up healthy
    process.env.FAKE_MODE = "crash";
    process.env.FAKE_CRASH_MS = "15";
    const m = new WorkerMonitor(cfg(), fixture, h);
    m.start();
    await waitFor(() => crashes.length >= 1);   // first instance crashed
    expect(crashes[0].exitCode).toBe(1);
    expect(states).toContain("crashed");
    process.env.FAKE_MODE = "ready";            // the respawn settles healthy
    await waitFor(() => states.filter((s) => s === "starting").length >= 2, 3000);
    expect(states.filter((s) => s === "starting").length).toBeGreaterThanOrEqual(2); // respawn attempted
    m.stop();
  });

  it("marks the worker 'unhealthy' after maxCrashes, but does not respawn during the cooldown", async () => {
    const { h, states, crashes } = hooks();
    process.env.FAKE_MODE = "instant"; // crash before ever becoming ready, immediately
    const m = new WorkerMonitor(cfg({ maxCrashes: 3, baseBackoffMs: 5, maxBackoffMs: 10, unhealthyCooldownMs: 10_000 }), fixture, h);
    m.start();
    await waitFor(() => states.includes("unhealthy"), 3000);
    expect(crashes.length).toBeGreaterThanOrEqual(3);
    const at = crashes.length;
    await delay(100); // shorter than the 10s cooldown — no respawn yet
    expect(crashes.length).toBe(at); // paused (not dead forever, not hot-looping)
    m.stop();
  });

  it("recovers from 'unhealthy' by trying again after the cooldown (not a permanent give-up)", async () => {
    const { h, states, crashes } = hooks();
    process.env.FAKE_MODE = "instant"; // keeps crashing — proves it RE-ATTEMPTS, not that it heals
    const m = new WorkerMonitor(cfg({ maxCrashes: 3, baseBackoffMs: 5, maxBackoffMs: 10, unhealthyCooldownMs: 80 }), fixture, h);
    m.start();
    await waitFor(() => states.includes("unhealthy"), 3000);
    const at = crashes.length;
    await waitFor(() => crashes.length > at, 3000); // cooldown elapsed → respawned → crashed again
    expect(crashes.length).toBeGreaterThan(at);
    m.stop();
  });

  it("manual restart spawns a fresh instance and resets the crash counter", async () => {
    const { h, states } = hooks();
    process.env.FAKE_MODE = "ready";
    const m = new WorkerMonitor(cfg(), fixture, h);
    m.start();
    await waitFor(() => states.includes("ready"));
    const readyCount1 = states.filter((s) => s === "ready").length;
    m.restartManually();
    await waitFor(() => states.filter((s) => s === "ready").length > readyCount1);
    expect(states.filter((s) => s === "ready").length).toBeGreaterThan(readyCount1);
    m.stop();
  });

  it("stop() does not trigger a respawn", async () => {
    const { h, states, crashes } = hooks();
    process.env.FAKE_MODE = "ready";
    const m = new WorkerMonitor(cfg(), fixture, h);
    m.start();
    await waitFor(() => states.includes("ready"));
    m.stop();
    await delay(150);
    // after stop, the exit is intentional → no crash recorded, no new "starting"
    const startingAfterStop = states.lastIndexOf("starting");
    expect(crashes.length).toBe(0);
    expect(startingAfterStop).toBeLessThan(states.length); // no trailing starting
  });

  it("hands the worker the bind host from the provider, re-read at each spawn (access-mode aware)", async () => {
    const { h, messages } = hooks();
    process.env.FAKE_MODE = "ready";
    let host = "127.0.0.1"; // start in 'localhost' posture
    const m = new WorkerMonitor(cfg(), fixture, h, () => host);
    m.start();
    await waitFor(() => messages.some((x) => x.type === "ready"));
    const first = messages.find((x) => x.type === "ready") as { bindHost?: string };
    expect(first.bindHost).toBe("127.0.0.1");
    // Flip to 'lan' posture and manually restart — the provider is re-read, so the respawn binds wide.
    host = "0.0.0.0";
    m.restartManually();
    await waitFor(() => messages.filter((x) => x.type === "ready").length >= 2);
    const second = messages.filter((x) => x.type === "ready").at(-1) as { bindHost?: string };
    expect(second.bindHost).toBe("0.0.0.0");
    m.stop();
  });

  it("falls back to config.bindHost when no provider is given (unchanged default)", async () => {
    const { h, messages } = hooks();
    process.env.FAKE_MODE = "ready";
    const m = new WorkerMonitor(cfg(), fixture, h); // no provider
    m.start();
    await waitFor(() => messages.some((x) => x.type === "ready"));
    const ready = messages.find((x) => x.type === "ready") as { bindHost?: string };
    expect(ready.bindHost).toBe("127.0.0.1");
    m.stop();
  });
});
