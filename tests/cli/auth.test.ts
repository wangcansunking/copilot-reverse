import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeviceLogin } from "../../src/cli/auth.js";
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
