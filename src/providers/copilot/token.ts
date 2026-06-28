const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
interface CopilotTokenResponse { token: string; expires_at: number }

// Thrown when the stored GitHub token can no longer be exchanged for a Copilot token
// (expired / revoked login). Carries an actionable message.
export class CopilotAuthError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401 || status === 403
        ? "GitHub login expired — restart copilot-reverse (or run `copilot-reverse login`) to re-authenticate"
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

// True if the stored GitHub token still exchanges for a Copilot token. A thin wrapper over
// probeGithubAuth so the token-exchange logic lives in exactly one place.
export async function isCopilotTokenValid(ghToken: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  return (await probeGithubAuth(ghToken, fetchFn)).ok;
}

// A classified auth check for the heartbeat. Unlike isCopilotTokenValid (a bare boolean), this
// distinguishes a DEFINITIVE auth failure (401/403) from a TRANSIENT one (timeout / 5xx / network /
// other). The heartbeat keeps the last-known-good status on transient errors, so a brief blip doesn't
// flip the UI to "expired". Known limitations of this code:
//   - The stickiness is UNBOUNDED: a SUSTAINED transient fault (a long GitHub outage, DNS down, a
//     persistently malformed body) also never surfaces — a connected badge stays green the whole time.
//     Only 401/403 ever flips the UI to "expired".
//   - 403 is treated as definitive here, but GitHub also returns 403 for some rate-limits; a rate-
//     limited 403 would therefore (incorrectly) read as "expired". (429 is correctly transient.)
export interface AuthProbe { ok: boolean; transient: boolean; detail: string }
export async function probeGithubAuth(ghToken: string, fetchFn: typeof fetch = fetch): Promise<AuthProbe> {
  try {
    await new CopilotTokenStore(ghToken, fetchFn).get();
    return { ok: true, transient: false, detail: "token valid" };
  } catch (e) {
    // CopilotTokenStore throws CopilotAuthError(status) for any non-ok response, and other errors
    // (AbortError on timeout, network failures) for the rest. We treat 401/403 as definitive auth
    // failures; everything else is transient. See the limitations noted above.
    if (e instanceof CopilotAuthError && (e.status === 401 || e.status === 403)) {
      return { ok: false, transient: false, detail: e.message };
    }
    return { ok: false, transient: true, detail: e instanceof Error ? e.message : String(e) };
  }
}
