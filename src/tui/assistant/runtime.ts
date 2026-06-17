import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildActions, type AssistantActions } from "./tools.js";
import type { DaemonClient } from "../daemon-client.js";

export interface AssistantConfig {
  client: DaemonClient;
  workerBaseUrl: string;   // e.g. http://127.0.0.1:7891  (Anthropic inbound)
  apiKey: string;          // maestro server key (worker ignores/accepts in M1)
  model: string;           // e.g. claude-opus-4-8 (router remaps to a Copilot model)
}

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
export async function runAssistantTurn(cfg: AssistantConfig, prompt: string, print: (line: string) => void): Promise<void> {
  // Dogfood: route the agent SDK through maestro's own Anthropic endpoint -> Copilot.
  process.env.ANTHROPIC_BASE_URL = cfg.workerBaseUrl;
  process.env.ANTHROPIC_API_KEY = cfg.apiKey;

  const actions = buildActions(cfg.client);
  const mcp = createSdkMcpServer({ name: "maestro", tools: sdkTools(actions) });

  const response = query({
    prompt,
    options: {
      model: cfg.model,
      mcpServers: { maestro: mcp },
      systemPrompt: "You are maestro's built-in assistant. Use the maestro tools to inspect and control the local proxy. Be concise.",
      permissionMode: "bypassPermissions",
    },
  });

  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") print(block.text);
      }
    }
  }
}
