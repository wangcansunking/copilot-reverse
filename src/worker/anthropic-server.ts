import { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse } from "../core/anthropic-inbound.js";
import { estimateTokens } from "../core/tokens.js";
import { errorHint } from "./errors.js";
import { CopilotAuthError } from "../providers/copilot/token.js";
import { isGatewayTool, type GatewayToolRunner } from "../core/server-tools.js";
import type { ContentBlock } from "../core/canonical.js";
import { RunawayGuard } from "../core/stream-guard.js";
import { toCanonical } from "../core/model-canonical.js";

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return {}; } };

// Bounds the gateway tool loop so a model that calls web_search every turn (or a runner that always
// returns "search more") can never spin forever inside one request.
const MAX_TOOL_ITERS = 5;

// Wall-clock cap on a single streaming turn. The model occasionally degenerates into emitting the
// same short token forever ("code\ncode\ncode…") and never sends a stop, which would otherwise relay
// for minutes and freeze the client. The RunawayGuard catches the repetition fast; this is the
// backstop for any slow-but-endless stream. On either trip we end the turn cleanly as max_tokens.
const STREAM_DEADLINE_MS = 120_000;

export function mountAnthropic(app: Express, router: Router, onMetric: MetricSink, runner?: GatewayToolRunner): void {
  // Model discovery — Anthropic list shape. Claude Desktop / Anthropic-protocol clients GET this
  // before chatting; without it they 404 on the connection test. Claude families are mapped to the
  // canonical id + display Claude Code recognises (with [1m] for 1M models) so its native picker shows
  // friendly names + the 1M badge; non-claude ids pass through. resolveModel maps them back inbound.
  app.get("/anthropic/v1/models", (_req, res) => {
    res.json({ data: router.listModels().map((id) => ({ type: "model", ...toCanonical(id) })), has_more: false });
  });

  // Anthropic clients (Claude Code) call this to size the prompt and decide when to auto-compact.
  app.post("/anthropic/v1/messages/count_tokens", (req, res) => {
    res.json({ input_tokens: estimateTokens(anthropicRequestToCanonical(req.body)) });
  });

  app.post("/anthropic/v1/messages", async (req, res) => {
    const start = Date.now();
    const canon = anthropicRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, opts: { error?: string; tokensIn?: number; tokensOut?: number } = {}) => onMetric({ endpoint: "/anthropic/v1/messages", model: canon.model, status, latencyMs: Date.now() - start, tokensIn: opts.tokensIn, tokensOut: opts.tokensOut, error: opts.error });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        // MUST be unique per message — Anthropic ids are unique and clients (Claude Code) key
        // their message store on it. A constant id made every answer overwrite/dedupe to the
        // first one, so different questions appeared to return the same content.
        const id = `msg_${randomUUID().replace(/-/g, "")}`;
        // Claude Code reads input_tokens from message_start to size the context bar, but the real
        // usage only arrives in the final frame. Seed message_start with an ESTIMATE so the bar
        // isn't stuck at 0%; the terminal message_delta then reports the exact count.
        const estInput = estimateTokens(canon);
        res.write(frame("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: canon.model, content: [], stop_reason: null, usage: { input_tokens: estInput, output_tokens: 0, cache_read_input_tokens: 0 } } }));

        // D3 (interface-freeze §5.4) + mixed text+tool fix (architect, 2026-06-17) + gateway tool loop
        // (2026-06): the endpoint owns block open/stop bookkeeping with DYNAMIC SEQUENTIAL allocation,
        // and `next` spans ALL loop iterations so block indices stay contiguous-from-0 across turns.
        // Within a turn, text streams live (transparent progress) but tool calls are BUFFERED: only
        // after the turn ends do we know whether they're gateway tools (run here, then loop) or client
        // tools (forwarded to the client, exactly as before). Whichever block opens first claims index 0.
        let next = 0;
        let lastPrompt = estInput, lastCached = 0, sumCompletion = 0;
        let finalStop: "stop" | "length" | "tool_use" | "error" = "stop";
        // Runaway protection spans the whole request: repeated-token degeneration + a wall-clock
        // deadline. Tripping ends the stream as a clean max_tokens turn instead of hanging.
        const guard = new RunawayGuard();
        const deadline = start + STREAM_DEADLINE_MS;
        let runaway = false;
        let runawayReason = "";

        for (let iter = 0; iter < MAX_TOOL_ITERS && !runaway; iter++) {
          let textIndex: number | undefined;                              // Anthropic index of this turn's text block
          const byCopilotIdx = new Map<number, { id: string; name: string; args: string }>();
          const buffered: { id: string; name: string; args: string }[] = []; // tool calls seen this turn, in order
          let turnStop: "stop" | "length" | "tool_use" | "error" = "stop";

          for await (const chunk of provider.stream(canon)) {
            if (chunk.done) {
              turnStop = chunk.finishReason ?? "stop";
              if (chunk.usage) { lastPrompt = chunk.usage.promptTokens ?? lastPrompt; lastCached = chunk.usage.cachedTokens ?? 0; sumCompletion += chunk.usage.completionTokens ?? 0; }
              break;
            }
            if (chunk.kind === "text") {
              if (textIndex === undefined) {
                textIndex = next++;
                res.write(frame("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }));
              }
              res.write(frame("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: chunk.delta } }));
              // Degenerate-stream kill-switch: a model looping on a short token is cut here.
              if (guard.push(chunk.delta)) { runaway = true; runawayReason = guard.reason ?? "repetition"; turnStop = "length"; break; }
            } else if (chunk.kind === "tool_use_start") {
              if (!byCopilotIdx.has(chunk.index)) { const t = { id: chunk.id, name: chunk.name, args: "" }; byCopilotIdx.set(chunk.index, t); buffered.push(t); }
            } else if (chunk.kind === "tool_use_delta") {
              const t = byCopilotIdx.get(chunk.index); if (t) t.args += chunk.argsDelta;
            }
            // Wall-clock backstop on EVERY chunk kind: a tool-call-only runaway never feeds the text
            // guard, so without this a model spamming calls would relay until the socket died.
            if (Date.now() > deadline) { runaway = true; runawayReason = "deadline"; turnStop = "length"; break; }
          }
          if (textIndex !== undefined) res.write(frame("content_block_stop", { type: "content_block_stop", index: textIndex }));

          // Runaway tripped mid-text: stop now as max_tokens. Don't forward partial tool calls or
          // loop into gateway tools — the turn was abandoned, not legitimately completed.
          if (runaway) { finalStop = "length"; break; }

          const gatewayCalls = buffered.filter((t) => isGatewayTool(t.name));

          // Invariant: a gateway tool (web_search/web_fetch) must NEVER reach the client — the client
          // has no handler for it and would stall. So whenever the model calls gateway tools (and a
          // runner is wired), run them here and loop, feeding results back. Any client tools called in
          // the SAME turn are deliberately NOT forwarded yet: we drop them this turn and let the model
          // re-issue them on the next turn, now informed by the search result. (Forwarding them now
          // would end the turn as tool_use and strand the gateway result with nowhere to go.)
          if (runner && gatewayCalls.length) {
            canon.messages.push({ role: "assistant", content: gatewayCalls.map((t): ContentBlock => ({ type: "tool_use", id: t.id, name: t.name, input: safeJson(t.args) })) });
            const results: ContentBlock[] = [];
            for (const t of gatewayCalls) results.push({ type: "tool_result", toolUseId: t.id, content: await runner(t.name, safeJson(t.args)) });
            canon.messages.push({ role: "tool", content: results });
            continue;
          }

          // Terminal turn (no gateway tools, or no runner): forward any buffered tool calls to the
          // client (open/delta/close each at its own freshly-allocated index), then finish.
          for (const t of buffered) {
            const index = next++;
            res.write(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } }));
            if (t.args) res.write(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: t.args } }));
            res.write(frame("content_block_stop", { type: "content_block_stop", index }));
          }
          finalStop = buffered.length ? "tool_use" : turnStop;
          break;
        }

        // Report real usage (agent-maestro shape): split cached tokens out of input so Claude Code's
        // context bar is accurate. promptTokens is the last turn's (largest, includes tool results);
        // output is summed across turns.
        const inputTokens = Math.max(0, lastPrompt - lastCached);
        const deltaUsage = { input_tokens: inputTokens, output_tokens: sumCompletion, cache_read_input_tokens: lastCached };
        res.write(frame("message_delta", { type: "message_delta", delta: { stop_reason: finalStop === "tool_use" ? "tool_use" : finalStop === "length" ? "max_tokens" : "end_turn" }, usage: deltaUsage }));
        res.write(frame("message_stop", { type: "message_stop" }));
        res.end();
        metric(200, { tokensIn: inputTokens, tokensOut: sumCompletion, error: runaway ? `runaway stream cut (${runawayReason}) — model degenerated, ended early as max_tokens` : undefined });
      } else {
        // Non-stream: same gateway loop without SSE — run gateway tools and re-complete until the
        // model answers with text (or a client tool), capped identically.
        let resp = await provider.complete(canon);
        for (let iter = 0; runner && iter < MAX_TOOL_ITERS; iter++) {
          const toolUses = resp.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
          const gatewayUses = toolUses.filter((b) => isGatewayTool(b.name));
          if (!gatewayUses.length) break; // no gateway work left — client tools / text are terminal
          // Run the gateway tools, feed results back, and continue. Any client tools in the SAME turn
          // ride along in the assistant message and remain in the final resp for the client to handle.
          canon.messages.push({ role: "assistant", content: resp.content });
          const results: ContentBlock[] = [];
          for (const u of gatewayUses) results.push({ type: "tool_result", toolUseId: u.id, content: await runner(u.name, u.input) });
          canon.messages.push({ role: "tool", content: results });
          resp = await provider.complete(canon);
        }
        // Invariant: never forward a gateway tool_use to the client (it can't handle it). If the cap
        // was hit with gateway calls still pending, strip them — better a partial answer than a stall.
        if (runner) resp = { ...resp, content: resp.content.filter((b) => b.type !== "tool_use" || !isGatewayTool((b as Extract<ContentBlock, { type: "tool_use" }>).name)) };
        res.json(canonicalToAnthropicResponse(resp));
        metric(200, { tokensIn: resp.usage?.promptTokens, tokensOut: resp.usage?.completionTokens });
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
      metric(status, { error: message });
    }
  });
}
