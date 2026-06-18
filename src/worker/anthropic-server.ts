import { type Express } from "express";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse } from "../core/anthropic-inbound.js";
import { CopilotAuthError } from "../providers/copilot/token.js";

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

        // D3 (interface-freeze §5.4) + mixed text+tool fix (architect, 2026-06-17): the endpoint owns
        // open/stop bookkeeping with DYNAMIC SEQUENTIAL allocation. We do NOT pre-open an index-0 text block,
        // and we do NOT map the Copilot tool index straight to the Anthropic block index (that collides with a
        // text preamble on a mixed turn). Instead, whichever block opens FIRST claims Anthropic index 0, the
        // next claims 1, etc. This keeps indices contiguous-from-0 in all three cases: pure-text (text@0),
        // pure-tool (tool@0), and mixed preamble+tool (text@0, tool@1).
        let next = 0;
        let textIndex: number | undefined;                  // Anthropic index of the (single) text block, once opened
        const toolIndex = new Map<number, number>();        // Copilot tool index -> Anthropic block index
        const openedOrder: number[] = [];                   // Anthropic indices in allocation order
        let stopReason: "stop" | "length" | "tool_use" | "error" = "stop";

        for await (const chunk of provider.stream(canon)) {
          if (chunk.done) { stopReason = chunk.finishReason ?? "stop"; break; }
          if (chunk.kind === "text") {
            if (textIndex === undefined) {
              textIndex = next++;
              openedOrder.push(textIndex);
              res.write(frame("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }));
            }
            res.write(frame("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: chunk.delta } }));
          } else if (chunk.kind === "tool_use_start") {
            if (!toolIndex.has(chunk.index)) {
              const index = next++;
              toolIndex.set(chunk.index, index);
              openedOrder.push(index);
              res.write(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: chunk.id, name: chunk.name, input: {} } }));
            }
          } else if (chunk.kind === "tool_use_delta") {
            const index = toolIndex.get(chunk.index);
            if (index !== undefined) res.write(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk.argsDelta } }));
          }
        }

        // Close every opened block (ascending Anthropic index) before the terminal frames.
        for (const index of [...openedOrder].sort((a, b) => a - b)) res.write(frame("content_block_stop", { type: "content_block_stop", index }));
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
      const status = err instanceof CopilotAuthError ? 401 : 502;
      if (!res.headersSent) res.status(status).json({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } });
      else res.end();
      metric(status);
    }
  });
}
