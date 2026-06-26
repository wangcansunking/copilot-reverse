import type { WorkerState } from "../shared/control-types.js";

// Status overview shown on startup and reflected in the HUD. GitHub's device-flow OAuth token has no
// real expiry (GitHub returns no expires_in for this app), so we report a LOGIN STATE, not a
// countdown: "connected" means the stored token still exchanges for a Copilot token, "expired" means
// it no longer does (revoked / re-auth needed), "signed-out" means there's no token at all.
export type GithubLoginState = "connected" | "expired" | "signed-out";
export type WebSearchState = "ready" | "not-configured";

export interface StatusInputs {
  hasToken: boolean;       // a GitHub token is stored
  tokenValid: boolean;     // that token still exchanges for a Copilot token (network-checked upstream)
  webSearchReady: boolean; // a WebIQ key is configured (env or data dir)
  worker: WorkerState;
  clients: { claude: boolean; codex: boolean };
}

export interface StatusSummary {
  github: GithubLoginState;
  webSearch: WebSearchState;
  worker: WorkerState;
  clients: { claude: boolean; codex: boolean };
}

export function githubLoginState(hasToken: boolean, tokenValid: boolean): GithubLoginState {
  if (!hasToken) return "signed-out";
  return tokenValid ? "connected" : "expired";
}

export function summarizeStatus(i: StatusInputs): StatusSummary {
  return {
    github: githubLoginState(i.hasToken, i.tokenValid),
    webSearch: i.webSearchReady ? "ready" : "not-configured",
    worker: i.worker,
    clients: i.clients,
  };
}
