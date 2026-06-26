import express, { type Express } from "express";
import type { Router } from "./router.js";
import { mountOpenAI } from "./openai-server.js";
import { mountAnthropic } from "./anthropic-server.js";
import type { GatewayToolRunner } from "../core/server-tools.js";

export type MetricSink = (m: { endpoint: string; model: string; status: number; latencyMs: number; error?: string }) => void;

export function createWorkerApp(router: Router, onMetric: MetricSink, gatewayRunner?: GatewayToolRunner): Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  mountOpenAI(app, router, onMetric);
  mountAnthropic(app, router, onMetric, gatewayRunner);
  return app;
}
