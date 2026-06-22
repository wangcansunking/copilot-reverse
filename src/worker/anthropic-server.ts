import { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse } from "../core/anthropic-inbound.js";
import { estimateTokens } from "../core/tokens.js";
import { errorHint } from "./errors.js";
import { CopilotAuthError } from "../providers/copilot/token.js";

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function mountAnthropic(app: Express, router: Router, onMetric: MetricSink): void {
  // Anthropic clients (Claude Code) call this to size the prompt and decide when to auto-compact.
  app.post("/v1/messages/count_tokens", (req, res) => {
    res.json({ input_tokens: estimateTokens(anthropicRequestToCanonical(req.body)) });
  });

  app.post("/v1/messages", async (req, res) => {
    const start = Date.now();
    const canon = anthropicRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, error?: string) => onMetric({ endpoint: "/v1/messages", model: canon.model, status, latencyMs: Date.now() - start, error });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        // MUST be unique per message — Anthropic ids are unique and clients (Claude Code) key
        // their message store on it. A constant id made every answer overwrite/dedupe to the
        // first one, so different questions appeared to return the same content.
        const id = `msg_${randomUUID().replace(/-/g, "")}`;
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
        let usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined;

        for await (const chunk of provider.stream(canon)) {
          if (chunk.done) { stopReason = chunk.finishReason ?? "stop"; usage = chunk.usage; break; }
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
        // Report real usage (agent-maestro shape): split cached tokens out of input so Claude Code's
        // context bar is accurate. Falls back to zeros if Copilot didn't return usage.
        const cached = usage?.cachedTokens ?? 0;
        const inputTokens = Math.max(0, (usage?.promptTokens ?? 0) - cached);
        const deltaUsage = { input_tokens: inputTokens, output_tokens: usage?.completionTokens ?? 0, cache_read_input_tokens: cached };
        res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: stopReason === "tool_use" ? "tool_use" : stopReason === "length" ? "max_tokens" : "end_turn" }, usage: deltaUsage }));
        res.write(frame("message_stop", { type: "message_stop" }));
        res.end();
        metric(200);
      } else {
        res.json(canonicalToAnthropicResponse(await provider.complete(canon)));
        metric(200);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const hint = errorHint(raw);
      const message = hint ? `${raw}\n${hint}` : raw;
      const status = err instanceof CopilotAuthError ? 401 : 502;
      const errorType = status === 401 ? "authentication_error" : "api_error";
      if (!res.headersSent) {
        res.status(status).json({ type: "error", error: { type: errorType, message } });
      } else {
        // The stream already opened (message_start sent), so we can't set a status code.
        // Emit an Anthropic `error` SSE event before closing so the client renders the
        // failure instead of seeing a silently truncated response.
        res.write(frame("error", { type: "error", error: { type: errorType, message } }));
        res.end();
      }
      metric(status, message);
    }
  });
}
