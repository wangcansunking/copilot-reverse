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

  it("is served at GET / by the control app", async () => {
    const app = createControlApp({
      db: openDb(":memory:"), getState: () => "ready",
      restart: () => {}, stop: () => {}, start: () => {}, doctor: async () => [],
      github: () => undefined,
      subscribe: () => () => {},
    });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/<!doctype html>/i);
  });
});
