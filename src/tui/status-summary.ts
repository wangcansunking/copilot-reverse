import type { WorkerState } from "../shared/control-types.js";
import type { WebSearchMode } from "../shared/webiq-key.js";

// Status overview shown on startup and reflected in the HUD. GitHub's device-flow OAuth token has no
// real expiry (GitHub returns no expires_in for this app), so we report a LOGIN STATE, not a
// countdown: "connected" means the stored token still exchanges for a Copilot token, "expired" means
// it no longer does (revoked / re-auth needed), "signed-out" means there's no token at all.
export type GithubLoginState = "connected" | "expired" | "signed-out";
// Web search is ALWAYS available now (default: borrow gpt-5-mini via the Copilot token), so we report
// the active BACKEND, not a configured/unconfigured state. "copilot" = native/borrow (no key); "webiq"
// = the user opted into Microsoft Web IQ via /webiq.
export type WebSearchState = WebSearchMode;

export interface StatusInputs {
  hasToken: boolean;       // a GitHub token is stored
  tokenValid: boolean;     // that token still exchanges for a Copilot token (network-checked upstream)
  webSearchMode: WebSearchMode; // active web-search backend (copilot borrow by default, or webiq)
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
    webSearch: i.webSearchMode,
    worker: i.worker,
    clients: i.clients,
  };
}
