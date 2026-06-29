import { describe, it, expect } from "vitest";
import request from "supertest";
import { dashboardHtml } from "../../src/supervisor/dashboard.js";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb } from "../../src/supervisor/db.js";

describe("dashboard", () => {
  it("is a self-contained HTML page that pulls the control API", () => {
    const html = dashboardHtml();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain("/api/status");
    expect(html).toContain("/api/requests");
    expect(html).toContain("/api/doctor");
  });

  it("pulls the new client + model panels and the github/web state", () => {
    const html = dashboardHtml();
    expect(html).toContain("/api/clients");
    expect(html).toContain("/api/models");
    // The page must reference the github login + web-search surfaces it now renders.
    expect(html).toMatch(/github/i);
    expect(html).toMatch(/web search/i);
  });

  it("counts a runaway-tagged 200 (error set) as an error, matching the TUI (not just status>=400)", () => {
    // The old dashboard counted only status>=400, so a runaway 200 (cut stream, error tagged) silently
    // vanished from the dashboard while /logs + /metrics flagged it. The shared isError rule must apply.
    const html = dashboardHtml();
    // The client-side counter must consider the error field, not just the status code.
    expect(html).toMatch(/\.error\s*!=\s*null|\.error\s*!==?\s*(null|undefined)|r\.error/);
  });

  it("is served at GET / by the control app", async () => {
    const app = createControlApp({
      db: openDb(":memory:"), getState: () => "ready",
      restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [],
      github: () => undefined, clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false } }),
      models: async () => [],
      subscribe: () => () => {},
    });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});
