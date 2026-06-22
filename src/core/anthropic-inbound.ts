import type { CanonicalRequest, CanonicalResponse, CanonicalMessage, ContentBlock } from "./canonical.js";

interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
interface AnthropicMsg { role: "user" | "assistant"; content: string | AnthropicBlock[] }
interface AnthropicTool { name: string; description?: string; input_schema: Record<string, unknown> }
interface AnthropicRequest {
  model: string; max_tokens: number; stream?: boolean; temperature?: number;
  system?: string | AnthropicBlock[]; tools?: AnthropicTool[]; messages: AnthropicMsg[];
}

// The Anthropic `system` field may be a plain string or an array of text blocks (the Claude Code
// SDK sends blocks with cache_control). Flatten either shape to a string — otherwise it stringifies
// to "[object Object]" and the model gets garbage instructions.
function systemText(system: string | AnthropicBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((b) => b.type === "text" && b.text != null).map((b) => b.text).join("");
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
  const sys = systemText(req.system);
  if (sys) messages.push({ role: "system", content: [{ type: "text", text: sys }] });
  for (const m of req.messages) {
    const content = blocksToCanonical(m.content);
    const isToolResult = content.some((b) => b.type === "tool_result");
    messages.push({ role: isToolResult ? "tool" : m.role, content });
  }
  return {
    model: req.model, stream: Boolean(req.stream), temperature: req.temperature, maxTokens: req.max_tokens,
    // Keep only custom tools with a real JSON-Schema. Anthropic server-side tools (web_search,
    // bash, computer, …) arrive with a `type` and no `input_schema`; forwarding them produces an
    // invalid tool the model can't fulfil, and the client hangs forever waiting for a tool_result.
    tools: req.tools
      ?.filter((t) => t.input_schema != null && typeof t.input_schema === "object")
      .map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
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
