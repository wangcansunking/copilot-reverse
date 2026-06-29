import { describe, it, expect } from "vitest";
import { openDb, recordRestart, listRestarts, recordRequest, recentRequests } from "../../src/supervisor/db.js";

describe("db", () => {
  it("restart events newest-first", () => {
    const db = openDb(":memory:");
    recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
    recordRestart(db, { ts: 2, reason: "crash", exitCode: 1, stderrTail: "b2", backoffMs: 1000, markedUnhealthy: 1 });
    const rows = listRestarts(db, 10);
    expect(rows[0].ts).toBe(2);
    expect(rows[0].markedUnhealthy).toBe(1);
  });
  it("request log newest-first", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 5, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 12 });
    expect(recentRequests(db, 10)[0].model).toBe("gpt-4o");
  });
  it("persists the error message of a failed request", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 7, endpoint: "/v1/messages", model: "claude-opus-4-8", status: 502, latencyMs: 30, error: "context_length_exceeded: prompt too long" });
    const row = recentRequests(db, 10)[0];
    expect(row.status).toBe(502);
    expect(row.error).toBe("context_length_exceeded: prompt too long");
  });
  it("persists token counts and omits them when absent", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 9, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 12, tokensIn: 120, tokensOut: 34 });
    recordRequest(db, { ts: 8, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 12 });
    const [withTok, without] = recentRequests(db, 10);
    expect(withTok.tokensIn).toBe(120);
    expect(withTok.tokensOut).toBe(34);
    expect(without.tokensIn).toBeUndefined();
    expect(without.tokensOut).toBeUndefined();
  });
});
