const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
interface CopilotTokenResponse { token: string; expires_at: number }

export class CopilotTokenStore {
  private cached?: { token: string; expiresAtMs: number };
  constructor(private ghToken: string, private fetchFn: typeof fetch = fetch, private nowMs: () => number = () => Date.now()) {}
  async get(): Promise<string> {
    const skewMs = 60_000;
    if (this.cached && this.cached.expiresAtMs - skewMs > this.nowMs()) return this.cached.token;
    const res = await this.fetchFn(COPILOT_TOKEN_URL, { headers: { authorization: `token ${this.ghToken}`, accept: "application/json" } });
    if (!res.ok) throw new Error(`copilot token exchange failed: ${res.status}`);
    const data = (await res.json()) as CopilotTokenResponse;
    this.cached = { token: data.token, expiresAtMs: data.expires_at * 1000 };
    return data.token;
  }
}
