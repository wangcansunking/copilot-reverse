import { describe, it, expect, vi } from "vitest";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

describe("ensureDaemon", () => {
  it("does not spawn when already healthy", async () => {
    const spawn = vi.fn();
    const probe = vi.fn(async () => true);
    const r = await ensureDaemon({ spawn, probe, retries: 3, delayMs: 0 });
    expect(r).toBe("already-running");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("spawns then waits until healthy", async () => {
    const spawn = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const r = await ensureDaemon({ spawn, probe, retries: 5, delayMs: 0 });
    expect(r).toBe("started");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("throws if never healthy", async () => {
    await expect(ensureDaemon({ spawn: vi.fn(), probe: async () => false, retries: 2, delayMs: 0 })).rejects.toThrow(/did not become healthy/i);
  });
});
