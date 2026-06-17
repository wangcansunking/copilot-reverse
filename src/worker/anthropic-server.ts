import { type Express } from "express";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse } from "../core/anthropic-inbound.js";

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function mountAnthropic(app: Express, router: Router, onMetric: MetricSink): void {
  app.post("/v1/messages", async (req, res) => {
    const start = Date.now();
    const canon = anthropicRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number) => onMetric({ endpoint: "/v1/messages", model: canon.model, status, latencyMs: Date.now() - start });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const id = `msg_${canon.model}`;
        res.write(frame("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: canon.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }));

        // D3 (interface-freeze §5.4): the endpoint owns open/stop bookkeeping. We do NOT pre-open an index-0
        // text block — that would emit a phantom empty text block (and collide at index 0) on a pure tool-call
        // turn, which is the COMMON case during M1c dogfood. Open each block lazily on its first chunk and
        // close every opened block before message_delta/message_stop.
        const opened = new Set<number>();
        let stopReason: "stop" | "length" | "tool_use" | "error" = "stop";

        for await (const chunk of provider.stream(canon)) {
          if (chunk.done) { stopReason = chunk.finishReason ?? "stop"; break; }
          if (chunk.kind === "text") {
            if (!opened.has(0)) { opened.add(0); res.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })); }
            res.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk.delta } }));
          } else if (chunk.kind === "tool_use_start") {
            if (!opened.has(chunk.index)) { opened.add(chunk.index); res.write(frame("content_block_start", { type: "content_block_start", index: chunk.index, content_block: { type: "tool_use", id: chunk.id, name: chunk.name, input: {} } })); }
          } else if (chunk.kind === "tool_use_delta") {
            res.write(frame("content_block_delta", { type: "content_block_delta", index: chunk.index, delta: { type: "input_json_delta", partial_json: chunk.argsDelta } }));
          }
        }

        // Close every opened block (ascending index) before the terminal frames.
        for (const index of [...opened].sort((a, b) => a - b)) res.write(frame("content_block_stop", { type: "content_block_stop", index }));
        res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: stopReason === "tool_use" ? "tool_use" : stopReason === "length" ? "max_tokens" : "end_turn" }, usage: { output_tokens: 0 } }));
        res.write(frame("message_stop", { type: "message_stop" }));
        res.end();
        metric(200);
      } else {
        res.json(canonicalToAnthropicResponse(await provider.complete(canon)));
        metric(200);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(502).json({ type: "error", error: { type: "api_error", message } });
      else res.end();
      metric(502);
    }
  });
}
