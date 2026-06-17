import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "./canonical.js";
import { joinText } from "./canonical.js";

interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
interface AnthropicMsg { role: "user" | "assistant"; content: string | AnthropicBlock[] }
interface AnthropicTool { name: string; description?: string; input_schema: Record<string, unknown> }
interface AnthropicRequest {
  model: string; max_tokens: number; stream?: boolean; temperature?: number;
  system?: string; tools?: AnthropicTool[]; messages: AnthropicMsg[];
}

function blocksToCanonical(content: string | AnthropicBlock[]): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text != null) out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id!, name: b.name!, input: b.input });
    else if (b.type === "tool_result") out.push({ type: "tool_result", toolUseId: b.tool_use_id!, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
  }
  return out;
}

export function anthropicRequestToCanonical(req: AnthropicRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  if (req.system) messages.push({ role: "system", content: [{ type: "text", text: req.system }] });
  for (const m of req.messages) {
    const content = blocksToCanonical(m.content);
    const isToolResult = content.some((b) => b.type === "tool_result");
    messages.push({ role: isToolResult ? "tool" : m.role, content });
  }
  return {
    model: req.model, stream: Boolean(req.stream), temperature: req.temperature, maxTokens: req.max_tokens,
    tools: req.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
    messages,
  };
}

export function canonicalToAnthropicResponse(r: CanonicalResponse) {
  const content = r.content.map((b) =>
    b.type === "text" ? { type: "text", text: b.text } :
    b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } :
    { type: "text", text: "" });
  const stop = r.finishReason === "tool_use" ? "tool_use" : r.finishReason === "length" ? "max_tokens" : "end_turn";
  return {
    id: r.id, type: "message" as const, role: "assistant" as const, model: r.model,
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: r.usage.promptTokens, output_tokens: r.usage.completionTokens },
  };
}

// Stateless per-chunk SSE. Caller emits message_start once before the first chunk (see worker server).
export function canonicalChunkToAnthropicSSE(chunk: CanonicalChunk, state: { index: number }): string {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (chunk.done) {
    return frame("message_delta", { type: "message_delta", delta: { stop_reason: chunk.finishReason === "tool_use" ? "tool_use" : "end_turn" }, usage: { output_tokens: 0 } })
      + frame("message_stop", { type: "message_stop" });
  }
  if (chunk.kind === "text") {
    return frame("content_block_delta", { type: "content_block_delta", index: state.index, delta: { type: "text_delta", text: chunk.delta } });
  }
  if (chunk.kind === "tool_use_start") {
    return frame("content_block_start", { type: "content_block_start", index: chunk.index, content_block: { type: "tool_use", id: chunk.id, name: chunk.name, input: {} } });
  }
  // tool_use_delta
  return frame("content_block_delta", { type: "content_block_delta", index: chunk.index, delta: { type: "input_json_delta", partial_json: chunk.argsDelta } });
}
