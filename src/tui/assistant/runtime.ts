import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildActions, type AssistantActions } from "./tools.js";
import type { DaemonClient } from "../daemon-client.js";

export interface AssistantConfig {
  client: DaemonClient;
  workerBaseUrl: string;   // e.g. http://127.0.0.1:7891  (Anthropic inbound)
  apiKey: string;          // maestro server key (worker ignores/accepts in M1)
  model: string;           // e.g. claude-opus-4-8 (router remaps to a Copilot model)
  maxInputTokens?: number; // conservative default context window; drives auto-compaction
  modelLimits?: Record<string, number>; // per-model real windows; preferred over maxInputTokens
}

// Injectable seam for the SDK's query(); production uses the real one (default).
// Tests inject a fake to exercise on-chat -> runtime -> consumption without
// spawning the bundled Claude Code CLI subprocess or calling live Copilot.
export type QueryFn = typeof query;

const empty = z.object({});

function sdkTools(actions: AssistantActions) {
  return [
    tool("get_status", "Get the proxy worker status and restart history", empty.shape, async () => ({ content: [{ type: "text", text: await actions.get_status({}) }] })),
    tool("restart_worker", "Restart the proxy worker", empty.shape, async () => ({ content: [{ type: "text", text: await actions.restart_worker({}) }] })),
    tool("run_doctor", "Run maestro health checks", empty.shape, async () => ({ content: [{ type: "text", text: await actions.run_doctor({}) }] })),
    tool("recent_requests", "List recent proxied requests", empty.shape, async () => ({ content: [{ type: "text", text: await actions.recent_requests({}) }] })),
  ];
}

// Runs one assistant turn, streaming assistant text to `print`.
export async function runAssistantTurn(cfg: AssistantConfig, prompt: string, print: (line: string) => void, queryFn: QueryFn = query): Promise<void> {
  // Dogfood: route the agent SDK through maestro's own Anthropic endpoint -> Copilot.
  process.env.ANTHROPIC_BASE_URL = cfg.workerBaseUrl;
  process.env.ANTHROPIC_API_KEY = cfg.apiKey;

  // The bundled Claude Code engine assumes a ~200K window and only auto-compacts near it,
  // but the routed Copilot model's real window is often far smaller -> a single turn can
  // overflow and the upstream rejects with context_length_exceeded. Mirror agent-maestro:
  // size auto-compaction to the model's real window, compact early, and drop the billing
  // attribution header that breaks prompt caching on a non-Anthropic gateway.
  const contextWindow = cfg.modelLimits?.[cfg.model] ?? cfg.maxInputTokens;
  if (contextWindow) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? "85";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";

  const actions = buildActions(cfg.client);
  const mcp = createSdkMcpServer({ name: "maestro", tools: sdkTools(actions) });

  const response = queryFn({
    prompt,
    options: {
      model: cfg.model,
      mcpServers: { maestro: mcp },
      systemPrompt: "You are maestro's built-in assistant. Use the maestro tools to inspect and control the local proxy. Be concise.",
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
    },
  });

  // Stream token-by-token from partial-message events for a live, SSE-like feel. Once any
  // delta has streamed, skip the final complete text block so the answer isn't printed twice.
  // If partial events never arrive (e.g. a stubbed transport), fall back to the full block.
  let streamed = false;
  for await (const message of response) {
    if (message.type === "stream_event") {
      const ev = message.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        streamed = true;
        print(ev.delta.text);
      }
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && !streamed) print(block.text);
      }
    } else if (message.type === "result" && message.subtype !== "success") {
      // Don't swallow a failed turn: surface the SDK's terminal error subtype.
      print(`assistant error: ${message.subtype}`);
    }
  }
}
