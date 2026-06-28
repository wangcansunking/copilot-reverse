import express, { type Express } from "express";
import { listRestarts, recentRequests, type Db } from "./db.js";
import { dashboardHtml } from "./dashboard.js";
import type { WorkerState, DoctorCheck, GithubStatus } from "../shared/control-types.js";

export interface ControlDeps {
  db: Db;
  getState: () => WorkerState;
  restart: () => void;
  stop: () => void;
  start: () => void;
  doctor: () => Promise<DoctorCheck[]>;
  github: () => GithubStatus | undefined;
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
  app.get("/api/doctor", async (_req, res) => res.json({ checks: await deps.doctor() }));
  app.get("/api/requests", (_req, res) => res.json({ requests: recentRequests(deps.db, 100) }));
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
    send("hello", { state: deps.getState() });
    off = deps.subscribe(send);
    req.on("close", off);
  });
  return app;
}
