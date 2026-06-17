import Database from "better-sqlite3";
import type { RestartRow, MetricSample } from "../shared/control-types.js";
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
      model TEXT NOT NULL, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL);
  `);
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
  db.prepare(`INSERT INTO request_log (ts, endpoint, model, status, latency_ms) VALUES (@ts, @endpoint, @model, @status, @latencyMs)`).run(m);
}
export function recentRequests(db: Db, limit: number): MetricSample[] {
  return db.prepare(`SELECT ts, endpoint, model, status, latency_ms as latencyMs FROM request_log ORDER BY ts DESC LIMIT ?`).all(limit) as MetricSample[];
}
