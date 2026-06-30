import { describe, it, expect } from "vitest";
import { openDb, recordRestart, listRestarts, recordRequest, recentRequests, aggregateRequests, recentErrorRows } from "../../src/supervisor/db.js";

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

describe("aggregateRequests (SQL over the whole table, not a capped fetch)", () => {
  it("counts ALL rows, beyond the old 100-row display cap", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 250; i++) recordRequest(db, { ts: i, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10, tokensIn: 1, tokensOut: 2 });
    const w = aggregateRequests(db);
    expect(w.total).toBe(250);        // real COUNT(*), not min(rows, 100)
    expect(w.tokensIn).toBe(250);
    expect(w.tokensOut).toBe(500);
    expect(w.byModel[0]).toMatchObject({ model: "gpt-4o", count: 250 });
  });

  it("rolls up per model: count, errors, avg latency, token sums", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10, tokensIn: 100, tokensOut: 50 });
    recordRequest(db, { ts: 2, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 30, tokensIn: 20, tokensOut: 10 });
    recordRequest(db, { ts: 3, endpoint: "/v1/messages", model: "gpt-4o", status: 502, latencyMs: 5, error: "boom" });
    recordRequest(db, { ts: 4, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 200, latencyMs: 100, tokensIn: 5, tokensOut: 5 });
    const w = aggregateRequests(db);
    expect(w.total).toBe(4);
    expect(w.errors).toBe(1);
    const gpt = w.byModel.find((r) => r.model === "gpt-4o")!;
    expect(gpt.count).toBe(3);
    expect(gpt.errors).toBe(1);
    expect(gpt.avgMs).toBe(15);     // (10+30+5)/3
    expect(gpt.tokensIn).toBe(120);
    expect(gpt.tokensOut).toBe(60);
  });

  it("counts a runaway-tagged 200 as an error (status>=400 OR error is set)", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1, endpoint: "/anthropic/v1/messages", model: "claude-opus-4-8", status: 200, latencyMs: 120000, error: "runaway stream cut" });
    recordRequest(db, { ts: 2, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10 });
    expect(aggregateRequests(db).errors).toBe(1);
  });

  it("filters to a since-window when given (last-24h)", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 1000, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10 }); // old
    recordRequest(db, { ts: 5000, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10 }); // recent
    expect(aggregateRequests(db).total).toBe(2);
    expect(aggregateRequests(db, 4000).total).toBe(1); // only ts >= 4000
  });
});

describe("recentErrorRows", () => {
  it("returns only failed rows from the WHOLE table, newest-first, capped", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 120; i++) recordRequest(db, { ts: i, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10 });
    recordRequest(db, { ts: 200, endpoint: "/v1/messages", model: "gpt-4o", status: 502, latencyMs: 5, error: "old-fail" });
    recordRequest(db, { ts: 201, endpoint: "/v1/messages", model: "gpt-4o", status: 200, latencyMs: 9, error: "runaway" });
    const errs = recentErrorRows(db, 10);
    expect(errs.map((e) => e.error)).toEqual(["runaway", "old-fail"]); // newest-first, only the two failures
  });
});
