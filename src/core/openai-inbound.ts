import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "./canonical.js";
import { joinText } from "./canonical.js";

interface OpenAIMsg { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string }
interface OpenAITool { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
interface OpenAIChatRequest {
  model: string; messages: OpenAIMsg[]; stream?: boolean;
  temperature?: number; max_tokens?: number; tools?: OpenAITool[];
}

function msgToCanonical(m: OpenAIMsg): CanonicalMessage {
  const role = (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as CanonicalMessage["role"];
  const content: ContentBlock[] = [];
  if (m.role === "tool" && m.tool_call_id) {
    content.push({ type: "tool_result", toolUseId: m.tool_call_id, content: m.content ?? "" });
  } else {
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls ?? []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    }
  }
  return { role, content };
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }

export function openaiRequestToCanonical(req: OpenAIChatRequest): CanonicalRequest {
  return {
    model: req.model,
    stream: Boolean(req.stream),
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    tools: req.tools?.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
    messages: req.messages.map(msgToCanonical),
  };
}

export function canonicalToOpenAIResponse(r: CanonicalResponse) {
  const toolCalls = r.content
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b, i) => ({ index: i, id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  return {
    id: r.id, object: "chat.completion" as const, created: 0, model: r.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: joinText(r.content) || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: r.finishReason === "tool_use" ? "tool_calls" : r.finishReason,
    }],
    usage: { prompt_tokens: r.usage.promptTokens, completion_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens },
  };
}

export function canonicalChunkToOpenAISSE(chunk: CanonicalChunk, id: string, model: string): string {
  if (chunk.done) return "data: [DONE]\n\n";
  let delta: Record<string, unknown> = {};
  if (chunk.kind === "text") delta = { content: chunk.delta };
  else if (chunk.kind === "tool_use_start") delta = { tool_calls: [{ index: chunk.index, id: chunk.id, type: "function", function: { name: chunk.name, arguments: "" } }] };
  else if (chunk.kind === "tool_use_delta") delta = { tool_calls: [{ index: chunk.index, function: { arguments: chunk.argsDelta } }] };
  const payload = { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: null }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}
