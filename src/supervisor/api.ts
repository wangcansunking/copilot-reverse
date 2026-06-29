import express, { type Express } from "express";
import { listRestarts, recentRequests, type Db } from "./db.js";
import { dashboardHtml } from "./dashboard.js";
import type { WorkerState, DoctorCheck, GithubStatus } from "../shared/control-types.js";
import type { ClientStatus } from "../tui/setup/status.js";

export interface DashModel { id: string; display_name?: string }
export interface ControlDeps {
  db: Db;
  getState: () => WorkerState;
  restart: () => void;
  stop: () => void;
  start: () => void;
  doctor: (ping?: boolean) => Promise<DoctorCheck[]>;
  github: () => GithubStatus | undefined;
  clients: () => ClientStatus;          // per-scope Claude/Codex config read from the real files
  models: () => Promise<DashModel[]>;   // advertised models (proxied from the worker), for the dashboard
  subscribe: (send: (event: string, data: unknown) => void) => () => void;
}

export function createControlApp(deps: ControlDeps): Express {
  const app = express();
  app.use(express.json());
  app.get("/", (_req, res) => res.type("html").send(dashboardHtml()));
  app.get("/api/status", (_req, res) => res.json({ workerState: deps.getState(), restarts: listRestarts(deps.db, 50), github: deps.github() }));
  app.post("/api/restart", (_req, res) => { deps.restart(); res.json({ ok: true }); });
  app.post("/api/stop", (_req, res) => { deps.stop(); res.json({ ok: true }); });
  app.post("/api/start", (_req, res) => { deps.start(); res.json({ ok: true }); });
  // ?ping=1 opts into the slower per-model connectivity probe (real 1-token requests); the dashboard's
  // 2s poll omits it and gets the cheap, upstream-free checks. Only the on-demand TUI /doctor sets it.
  app.get("/api/doctor", async (req, res) => res.json({ checks: await deps.doctor(req.query.ping === "1") }));
  app.get("/api/requests", (_req, res) => res.json({ requests: recentRequests(deps.db, 100) }));
  app.get("/api/clients", (_req, res) => res.json(deps.clients()));
  // Proxied from the worker so the dashboard shows the SAME models the picker advertises. Best-effort:
  // an empty list (worker momentarily down) renders as "discovery unavailable", not a 500.
  app.get("/api/models", async (_req, res) => { try { res.json({ models: await deps.models() }); } catch { res.json({ models: [] }); } });
  app.get("/api/events", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders?.();
    let off = () => {};
    // Writing to a socket that died between broadcasts throws synchronously (ERR_STREAM_DESTROYED /
    // EPIPE). emit() calls this on the worker-message path, so an uncaught throw would crash the
    // in-process supervisor + TUI. Swallow the write error and unsubscribe — a dead connection should
    // be dropped, not retried.
    const send = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { off(); }
    };
    // Subscribe BEFORE the first write so that if the hello frame throws (socket already dead), the
    // catch's off() refers to the real unsubscribe rather than the no-op default — otherwise a dead
    // connection would stay subscribed until the next emit or 'close'.
    off = deps.subscribe(send);
    send("hello", { state: deps.getState() });
    req.on("close", off);
  });
  return app;
}
