import { describe, it, expect } from "vitest";
import { githubLoginState, summarizeStatus, type StatusInputs } from "../../src/tui/status-summary.js";

describe("githubLoginState", () => {
  it("signed-out when there is no token", () => {
    expect(githubLoginState(false, false)).toBe("signed-out");
  });
  it("expired when a token exists but no longer exchanges", () => {
    expect(githubLoginState(true, false)).toBe("expired");
  });
  it("connected when the token exchanges for a Copilot token", () => {
    expect(githubLoginState(true, true)).toBe("connected");
  });
});

describe("summarizeStatus", () => {
  const base: StatusInputs = {
    hasToken: true, tokenValid: true, webSearchReady: true,
    worker: "ready", clients: { claude: true, codex: false },
  };
  it("maps a fully-configured environment", () => {
    const s = summarizeStatus(base);
    expect(s.github).toBe("connected");
    expect(s.webSearch).toBe("ready");
    expect(s.worker).toBe("ready");
    expect(s.clients).toEqual({ claude: true, codex: false });
  });
  it("reports web search as not configured when no key is present", () => {
    expect(summarizeStatus({ ...base, webSearchReady: false }).webSearch).toBe("not-configured");
  });
  it("reports github expired when token present but invalid", () => {
    expect(summarizeStatus({ ...base, tokenValid: false }).github).toBe("expired");
  });
  it("reports github signed-out when no token", () => {
    expect(summarizeStatus({ ...base, hasToken: false, tokenValid: false }).github).toBe("signed-out");
  });
});
