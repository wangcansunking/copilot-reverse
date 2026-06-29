import express, { type Express } from "express";
import type { Router } from "./router.js";
import { mountOpenAI } from "./openai-server.js";
import { mountAnthropic } from "./anthropic-server.js";
import { requireAccess, type AccessControl } from "./auth.js";
import type { GatewayToolRunner } from "../core/server-tools.js";

export type MetricSink = (m: { endpoint: string; model: string; status: number; latencyMs: number; tokensIn?: number; tokensOut?: number; error?: string }) => void;

// Default access control: localhost mode, not exposed, no key — i.e. serve everything, exactly as
// before access modes existed. Tests and any caller that doesn't pass `access` get the original open
// behavior.
const OPEN: AccessControl = { mode: () => "localhost", key: () => null, exposed: false };

export function createWorkerApp(router: Router, onMetric: MetricSink, gatewayRunner?: GatewayToolRunner, access: AccessControl = OPEN): Express {
  const app = express();
  // Readiness probe stays OPEN above the auth gate — the supervisor must reach /healthz to know the
  // worker is up even in LAN mode (it's a no-secret GET, not a proxy path).
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  // Gate BEFORE the body parser: the key lives in headers, so an unauthenticated LAN request is
  // rejected without ever buffering its (up-to-20mb) body. Healthz above is already answered.
  app.use(requireAccess(access));
  app.use(express.json({ limit: "20mb" }));
  mountOpenAI(app, router, onMetric);
  mountAnthropic(app, router, onMetric, gatewayRunner);
  return app;
}

