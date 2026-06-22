import { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { openaiRequestToCanonical, canonicalToOpenAIResponse, canonicalChunkToOpenAISSE } from "../core/openai-inbound.js";
import { errorHint } from "./errors.js";
import { CopilotAuthError } from "../providers/copilot/token.js";

export function mountOpenAI(app: Express, router: Router, onMetric: MetricSink): void {
  app.post("/v1/chat/completions", async (req, res) => {
    const start = Date.now();
    const canon = openaiRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, error?: string) => onMetric({ endpoint: "/v1/chat/completions", model: canon.model, status, latencyMs: Date.now() - start, error });
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
}
