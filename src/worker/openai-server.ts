import { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { openaiRequestToCanonical, canonicalToOpenAIResponse, canonicalChunkToOpenAISSE } from "../core/openai-inbound.js";
import { responsesRequestToCanonical, canonicalToResponsesResponse, ResponsesSSE } from "../core/responses-inbound.js";
import { errorHint } from "./errors.js";
import { CopilotAuthError } from "../providers/copilot/token.js";

export function mountOpenAI(app: Express, router: Router, onMetric: MetricSink): void {
  // Model discovery — OpenAI list shape. Clients (LiteLLM-style gateways, "test connection" probes)
  // GET this before chatting; without it they 404 and refuse to connect.
  app.get("/openai/models", (_req, res) => {
    res.json({ object: "list", data: router.listModels().map((id) => ({ id, object: "model", owned_by: "copilot-reverse" })) });
  });

  app.post("/openai/chat/completions", async (req, res) => {
    const start = Date.now();
    const canon = openaiRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, error?: string) => onMetric({ endpoint: "/openai/chat/completions", model: canon.model, status, latencyMs: Date.now() - start, error });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`; // unique per response, not constant
        for await (const chunk of provider.stream(canon)) res.write(canonicalChunkToOpenAISSE(chunk, id, canon.model));
        res.end();
        metric(200);
      } else {
        res.json(canonicalToOpenAIResponse(await provider.complete(canon)));
        metric(200);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const hint = errorHint(raw);
      const message = hint ? `${raw}\n${hint}` : raw;
      const status = err instanceof CopilotAuthError ? 401 : 502;
      if (!res.headersSent) {
        res.status(status).json({ error: { message } });
      } else {
        // Stream already opened: surface the failure as a final error chunk so the client
        // sees it instead of a silently truncated response, then close the stream.
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        res.end();
      }
      metric(status, message);
    }
  });

  // OpenAI Responses API — Codex speaks ONLY this after codex#7782 removed wire_api="chat". Codex
  // POSTs {base_url}/responses, so with base_url …/openai the route is /openai/responses. Same
  // canonical pipeline as chat/completions; the Responses translator handles the item-centric shape.
  app.post("/openai/responses", async (req, res) => {
    const start = Date.now();
    const canon = responsesRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, error?: string) => onMetric({ endpoint: "/openai/responses", model: canon.model, status, latencyMs: Date.now() - start, error });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const sse = new ResponsesSSE(`resp_${randomUUID().replace(/-/g, "")}`, canon.model);
        res.write(sse.start());
        const argsByIdx = new Map<number, string>();
        let usage: { promptTokens: number; completionTokens: number } | undefined;
        let finish = "stop";
        for await (const chunk of provider.stream(canon)) {
          if (chunk.done) { finish = chunk.finishReason ?? "stop"; usage = chunk.usage; break; }
          if (chunk.kind === "text") for (const f of sse.text(chunk.delta)) res.write(f);
          else if (chunk.kind === "tool_use_start") for (const f of sse.toolStart(chunk.index, chunk.id, chunk.name)) res.write(f);
          else if (chunk.kind === "tool_use_delta") { argsByIdx.set(chunk.index, (argsByIdx.get(chunk.index) ?? "") + chunk.argsDelta); for (const f of sse.toolArgs(chunk.index, chunk.argsDelta)) res.write(f); }
        }
        for (const f of sse.finish(usage, finish, argsByIdx)) res.write(f);
        res.end();
        metric(200);
      } else {
        res.json(canonicalToResponsesResponse(await provider.complete(canon)));
        metric(200);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const hint = errorHint(raw);
      const message = hint ? `${raw}\n${hint}` : raw;
      const status = err instanceof CopilotAuthError ? 401 : 502;
      if (!res.headersSent) {
        res.status(status).json({ error: { type: "error", message } });
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.end();
      }
      metric(status, message);
    }
  });
}
