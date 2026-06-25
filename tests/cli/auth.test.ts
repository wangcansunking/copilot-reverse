import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeviceLogin, beginDeviceLogin } from "../../src/cli/auth.js";
import { readGhToken } from "../../src/shared/creds.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("runDeviceLogin", () => {
  it("walks device flow and persists token", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const f = vi.fn()
      .mockResolvedValueOnce(json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }))
      .mockResolvedValueOnce(json({ access_token: "gho_z" }));
    const log = vi.fn();
    await runDeviceLogin(d, f as unknown as typeof fetch, log);
    expect(readGhToken(d)).toBe("gho_z");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AB-12"));
  });
});

describe("beginDeviceLogin (two-phase)", () => {
  it("returns the device code immediately, before any token poll runs", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    let polled = false;
    const f = vi.fn()
      .mockResolvedValueOnce(json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }))
      .mockImplementationOnce(() => { polled = true; return Promise.resolve(json({ access_token: "gho_z" })); });

    const { code, complete } = await beginDeviceLogin(d, f as unknown as typeof fetch);
    // The verification code is available without waiting for authorization.
    expect(code.user_code).toBe("AB-12");
    expect(code.verification_uri).toContain("github.com/login/device");
    expect(polled).toBe(false);

    // Completing the flow then polls and persists the token.
    await complete();
    expect(polled).toBe(true);
    expect(readGhToken(d)).toBe("gho_z");
  });
});
