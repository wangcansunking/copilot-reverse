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
  it("posts stop and start to the right paths", async () => {
    const f = vi.fn(async () => json({ ok: true }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    await c.stop();
    await c.start();
    expect(f.mock.calls[0][0]).toBe("http://x/api/stop");
    expect(f.mock.calls[1][0]).toBe("http://x/api/start");
  });
  it("unwraps the requests array", async () => {
    const f = vi.fn(async () => json({ requests: [{ ts: 1, endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 4 }] }));
    const reqs = await new DaemonClient("http://x", f as unknown as typeof fetch).requests();
    expect(reqs[0].model).toBe("m");
  });
});
