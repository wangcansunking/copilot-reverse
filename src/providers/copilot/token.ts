const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
interface CopilotTokenResponse { token: string; expires_at: number }

// Thrown when the stored GitHub token can no longer be exchanged for a Copilot token
// (expired / revoked login). Carries an actionable message.
export class CopilotAuthError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401 || status === 403
        ? "GitHub login expired — restart maestro (or run `maestro login`) to re-authenticate"
        : `copilot token exchange failed: ${status}`,
    );
    this.name = "CopilotAuthError";
  }
}

export class CopilotTokenStore {
  private cached?: { token: string; expiresAtMs: number };
  constructor(private ghToken: string, private fetchFn: typeof fetch = fetch, private nowMs: () => number = () => Date.now()) {}
  async get(): Promise<string> {
    const skewMs = 60_000;
    if (this.cached && this.cached.expiresAtMs - skewMs > this.nowMs()) return this.cached.token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try { res = await this.fetchFn(COPILOT_TOKEN_URL, { headers: { authorization: `token ${this.ghToken}`, accept: "application/json" }, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!res.ok) throw new CopilotAuthError(res.status);
    const data = (await res.json()) as CopilotTokenResponse;
    this.cached = { token: data.token, expiresAtMs: data.expires_at * 1000 };
    return data.token;
  }
}

// True if the stored GitHub token still exchanges for a Copilot token.
export async function isCopilotTokenValid(ghToken: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try { await new CopilotTokenStore(ghToken, fetchFn).get(); return true; }
  catch { return false; }
}
