import { describe, it, expect } from "vitest";
import { buildIssueUrl, buildIssueBody, buildIssueTitle, PLACEHOLDER_REPO } from "../../src/tui/report.js";
import type { MetricSample } from "../../src/shared/control-types.js";

const errors: MetricSample[] = [
  { ts: 1, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 5, error: "context_length_exceeded: prompt too long" },
];
const input = {
  repo: "octo/copilot-reverse",
  version: "0.0.1",
  platform: "win32 node-v20",
  status: { workerState: "ready" as const, restarts: [] },
  doctor: [{ name: "github-auth", ok: false, detail: "token expired" }],
  errors,
};

describe("report", () => {
  it("builds a GitHub new-issue URL pointed at the configured repo", () => {
    const url = buildIssueUrl(input);
    expect(url.startsWith("https://github.com/octo/copilot-reverse/issues/new?")).toBe(true);
    expect(url).toContain("title=");
    expect(url).toContain("body=");
    // the failing error message is carried into the prefilled issue
    expect(decodeURIComponent(url)).toContain("context_length_exceeded");
  });

  it("body includes diagnostics (version, platform, doctor, recent errors)", () => {
    const body = buildIssueBody(input);
    expect(body).toContain("0.0.1");
    expect(body).toContain("win32 node-v20");
    expect(body).toContain("github-auth");
    expect(body).toContain("context_length_exceeded");
  });

  it("exposes a placeholder repo constant for the unset guard", () => {
    expect(PLACEHOLDER_REPO).toMatch(/OWNER/);
  });

  it("surfaces a runaway (200 cut by the guard) as its own section + title", () => {
    const runaway: MetricSample = { ts: 2, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 200, latencyMs: 120000, error: "runaway stream cut (repetition) — model degenerated, ended early as max_tokens" };
    const i = { ...input, errors: [runaway] };
    expect(buildIssueTitle(i)).toMatch(/stream runaway/);
    const body = buildIssueBody(i);
    expect(body).toContain("Stream runaways");
    expect(body).toContain("repetition");
    expect(body).toContain("120000ms");
  });
});
