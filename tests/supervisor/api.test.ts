import { describe, it, expect } from "vitest";
import request from "supertest";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart, recordRequest } from "../../src/supervisor/db.js";

function fixture() {
  const db = openDb(":memory:");
  recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
  recordRequest(db, { ts: 2, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 9 });
  const calls: string[] = [];
  const app = createControlApp({
    db,
    getState: () => "ready",
    restart: () => calls.push("restart"),
    stop: () => calls.push("stop"),
    start: () => calls.push("start"),
    doctor: async () => [{ name: "copilot-auth", ok: true, detail: "token present" }],
    subscribe: () => () => {},
  });
  return { app, calls };
}

describe("control api", () => {
  it("status", async () => {
    const res = await request(fixture().app).get("/api/status");
    expect(res.body.workerState).toBe("ready");
    expect(res.body.restarts[0].stderrTail).toBe("boom");
  });
  it("restart action", async () => {
    const fx = fixture();
    await request(fx.app).post("/api/restart");
    expect(fx.calls).toContain("restart");
  });
  it("doctor", async () => {
    const res = await request(fixture().app).get("/api/doctor");
    expect(res.body.checks[0].ok).toBe(true);
  });
  it("recent requests", async () => {
    const res = await request(fixture().app).get("/api/requests");
    expect(res.body.requests[0].model).toBe("gpt-4o");
  });
});
