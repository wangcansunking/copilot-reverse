import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../../src/tui/daemon-client.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("DaemonClient", () => {
  it("reads status", async () => {
    const f = vi.fn(async () => json({ workerState: "ready", restarts: [] }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    expect((await c.status()).workerState).toBe("ready");
  });
  it("posts restart", async () => {
    const f = vi.fn(async () => json({ ok: true }));
    await new DaemonClient("http://x", f as unknown as typeof fetch).restart();
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
  it("runs doctor", async () => {
    const f = vi.fn(async () => json({ checks: [{ name: "x", ok: true, detail: "d" }] }));
    expect((await new DaemonClient("http://x", f as unknown as typeof fetch).doctor())[0].ok).toBe(true);
  });
});
