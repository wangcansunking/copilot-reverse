import { describe, it, expect, vi } from "vitest";
import { CopilotTokenStore, CopilotAuthError, isCopilotTokenValid, probeGithubAuth } from "../../../src/providers/copilot/token.js";
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
  it("throws an actionable CopilotAuthError on 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await expect(s.get()).rejects.toBeInstanceOf(CopilotAuthError);
    await expect(s.get()).rejects.toThrow(/login expired/i);
  });
});

describe("isCopilotTokenValid", () => {
  it("true when the token exchanges", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    expect(await isCopilotTokenValid("gho", f as unknown as typeof fetch)).toBe(true);
  });
  it("false on 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    expect(await isCopilotTokenValid("gho", f as unknown as typeof fetch)).toBe(false);
  });
});

describe("probeGithubAuth", () => {
  it("ok + non-transient when the token exchanges", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    expect(await probeGithubAuth("gho", f as unknown as typeof fetch)).toEqual({ ok: true, transient: false, detail: "token valid" });
  });
  it("definitive failure (non-transient) on 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(false);
    expect(p.detail).toMatch(/login expired/i);
  });
  it("definitive failure (non-transient) on 403", async () => {
    const f = vi.fn(async () => new Response("", { status: 403 }));
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(false);
  });
  it("transient on a 5xx (upstream hiccup, not an auth failure)", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(true);
  });
  it("transient when the network call rejects", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(true);
  });
});
