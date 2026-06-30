import Database from "better-sqlite3";
import type { RestartRow, MetricSample, MetricsWindow, ModelRollup } from "../shared/control-types.js";
export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS restart_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, reason TEXT NOT NULL,
      exit_code INTEGER, stderr_tail TEXT NOT NULL, backoff_ms INTEGER NOT NULL, marked_unhealthy INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, endpoint TEXT NOT NULL,
      model TEXT NOT NULL, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER, error TEXT);
  `);
  // Migrate request_log tables created before later columns existed.
  const cols = db.prepare(`PRAGMA table_info(request_log)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "error")) db.exec(`ALTER TABLE request_log ADD COLUMN error TEXT`);
  if (!cols.some((c) => c.name === "tokens_in")) db.exec(`ALTER TABLE request_log ADD COLUMN tokens_in INTEGER`);
  if (!cols.some((c) => c.name === "tokens_out")) db.exec(`ALTER TABLE request_log ADD COLUMN tokens_out INTEGER`);
  return db;
}

export function recordRestart(db: Db, e: RestartRow & { backoffMs: number }): void {
  db.prepare(`INSERT INTO restart_events (ts, reason, exit_code, stderr_tail, backoff_ms, marked_unhealthy)
    VALUES (@ts, @reason, @exitCode, @stderrTail, @backoffMs, @markedUnhealthy)`).run(e);
}
export function listRestarts(db: Db, limit: number): RestartRow[] {
  return db.prepare(`SELECT ts, reason, exit_code as exitCode, stderr_tail as stderrTail, marked_unhealthy as markedUnhealthy
    FROM restart_events ORDER BY ts DESC LIMIT ?`).all(limit) as RestartRow[];
}
export function recordRequest(db: Db, m: Omit<MetricSample, "ts"> & { ts: number }): void {
  db.prepare(`INSERT INTO request_log (ts, endpoint, model, status, latency_ms, tokens_in, tokens_out, error) VALUES (@ts, @endpoint, @model, @status, @latencyMs, @tokensIn, @tokensOut, @error)`)
    .run({ tokensIn: null, tokensOut: null, error: null, ...m });
}
export function recentRequests(db: Db, limit: number): MetricSample[] {
  return (db.prepare(`SELECT ts, endpoint, model, status, latency_ms as latencyMs, tokens_in as tokensIn, tokens_out as tokensOut, error FROM request_log ORDER BY ts DESC LIMIT ?`).all(limit) as (MetricSample & { tokensIn: number | null; tokensOut: number | null; error: string | null })[])
    .map(({ tokensIn, tokensOut, error, ...r }) => ({ ...r, ...(tokensIn != null ? { tokensIn } : {}), ...(tokensOut != null ? { tokensOut } : {}), ...(error != null ? { error } : {}) }));
}

// A request "failed" if it returned a 4xx/5xx OR carries an error message — a runaway stream finishes
// 200 but tags an error. Shared by aggregate + recentErrors so the counts agree everywhere.
const FAILED = `(status >= 400 OR error IS NOT NULL)`;

// Roll up the WHOLE request_log in SQL — a real COUNT(*)/SUM, not min(rows, 100). Pass `sinceMs` to
// window it (e.g. last 24h). This is what /metrics should show: the old path aggregated a capped
// 100-row fetch, so "100 reqs" was a ceiling that told you nothing once you crossed it.
export function aggregateRequests(db: Db, sinceMs?: number): MetricsWindow {
  const where = sinceMs != null ? `WHERE ts >= @since` : ``;
  const args = sinceMs != null ? { since: sinceMs } : {};
  const byModel = db.prepare(`
    SELECT model,
           COUNT(*) AS count,
           SUM(CASE WHEN ${FAILED} THEN 1 ELSE 0 END) AS errors,
           CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avgMs,
           COALESCE(SUM(tokens_in), 0) AS tokensIn,
           COALESCE(SUM(tokens_out), 0) AS tokensOut
    FROM request_log ${where}
    GROUP BY model ORDER BY count DESC`).all(args) as ModelRollup[];
  return {
    total: byModel.reduce((n, r) => n + r.count, 0),
    errors: byModel.reduce((n, r) => n + r.errors, 0),
    tokensIn: byModel.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: byModel.reduce((n, r) => n + r.tokensOut, 0),
    byModel,
  };
}

// The failed rows (4xx/5xx or tagged error) from the WHOLE table, newest-first, capped — the actual
// "what failed and why" log. Distinct from recentRequests, which slices the last N of everything and
// so can miss errors that scrolled past the window.
export function recentErrorRows(db: Db, limit: number): MetricSample[] {
  return (db.prepare(`SELECT ts, endpoint, model, status, latency_ms as latencyMs, tokens_in as tokensIn, tokens_out as tokensOut, error FROM request_log WHERE ${FAILED} ORDER BY ts DESC LIMIT ?`).all(limit) as (MetricSample & { tokensIn: number | null; tokensOut: number | null; error: string | null })[])
    .map(({ tokensIn, tokensOut, error, ...r }) => ({ ...r, ...(tokensIn != null ? { tokensIn } : {}), ...(tokensOut != null ? { tokensOut } : {}), ...(error != null ? { error } : {}) }));
}
