// Community-documented GitHub Copilot OAuth (unofficial; may change).
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface DeviceCode {
  device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number;
}

export async function requestDeviceCode(fetchFn: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
  return (await res.json()) as DeviceCode;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pollForToken(deviceCode: string, intervalMs: number, fetchFn: typeof fetch = fetch): Promise<string> {
  for (;;) {
    const res = await fetchFn(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (data.access_token) return data.access_token;
    if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") throw new Error(`authorization failed: ${data.error}`);
    await sleep(intervalMs);
  }
}
