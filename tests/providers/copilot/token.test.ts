import { describe, it, expect, vi } from "vitest";
import { CopilotTokenStore } from "../../../src/providers/copilot/token.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("CopilotTokenStore", () => {
  it("caches until near expiry", async () => {
    const now = 1_000_000;
    const f = vi.fn(async () => json({ token: "cop_1", expires_at: 1_000 + now / 1000 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch, () => now);
    expect(await s.get()).toBe("cop_1");
    expect(await s.get()).toBe("cop_1");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refreshes after expiry", async () => {
    let now = 0;
    const f = vi.fn().mockResolvedValueOnce(json({ token: "cop_1", expires_at: 100 })).mockResolvedValueOnce(json({ token: "cop_2", expires_at: 10_000 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch, () => now);
    expect(await s.get()).toBe("cop_1");
    now = 200_000;
    expect(await s.get()).toBe("cop_2");
  });
});
