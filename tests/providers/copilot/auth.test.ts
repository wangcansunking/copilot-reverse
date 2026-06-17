import { describe, it, expect, vi } from "vitest";
import { requestDeviceCode, pollForToken } from "../../../src/providers/copilot/auth.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("copilot auth", () => {
  it("requests a device code", async () => {
    const f = vi.fn(async () => json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }));
    const r = await requestDeviceCode(f as unknown as typeof fetch);
    expect(r.user_code).toBe("AB-12");
  });
  it("polls until authorized", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ error: "authorization_pending" })).mockResolvedValueOnce(json({ access_token: "gho_x" }));
    expect(await pollForToken("dc", 0, f as unknown as typeof fetch)).toBe("gho_x");
    expect(f).toHaveBeenCalledTimes(2);
  });
});
