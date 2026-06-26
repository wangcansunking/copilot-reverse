import type { CanonicalRequest, CanonicalResponse, CanonicalMessage, ContentBlock } from "./canonical.js";
import { GATEWAY_TOOL_DEFS, isGatewayTool } from "./server-tools.js";

interface AnthropicImageSource { type: "base64" | "url"; media_type?: string; data?: string; url?: string }
interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; source?: AnthropicImageSource }
interface AnthropicMsg { role: "user" | "assistant"; content: string | AnthropicBlock[] }
// Custom tools carry an input_schema. Server-side tools (web_search, web_fetch, bash, computer, …)
// instead carry a dated `type` (e.g. "web_search_20250305") and a bare `name`, with no schema.
interface AnthropicTool { type?: string; name: string; description?: string; input_schema?: Record<string, unknown> }
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
    else if (b.type === "image" && b.source) {
      // Anthropic image: base64 (media_type + data) or a url source. Normalize to a data URL.
      const dataUrl = b.source.type === "url" && b.source.url
        ? b.source.url
        : `data:${b.source.media_type ?? "image/png"};base64,${b.source.data ?? ""}`;
      out.push({ type: "image", dataUrl });
    }
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
    tools: mapTools(req.tools),
    messages,
  };
}

// Custom tools (with a real JSON-Schema) pass through. Anthropic server-side tools arrive with a
// dated `type` and no input_schema: web_search / web_fetch are converted to gateway function tools
// (the gateway runs them itself against WebIQ), and every OTHER server tool (bash, computer, …) is
// dropped — forwarding an unfulfillable tool makes the client hang forever waiting for a result.
function mapTools(tools: AnthropicTool[] | undefined): CanonicalRequest["tools"] {
  if (!tools) return undefined;
  const out: NonNullable<CanonicalRequest["tools"]> = [];
  let injectedGateway = false;
  for (const t of tools) {
    if (t.input_schema != null && typeof t.input_schema === "object") {
      out.push({ name: t.name, description: t.description, parameters: t.input_schema });
    } else if (isGatewayTool(t.name) && !injectedGateway) {
      // Replace the schema-less server tool with our gateway defs. Inject the whole set once so the
      // model can use both web_search and web_fetch whenever it asks for either.
      out.push(...GATEWAY_TOOL_DEFS);
      injectedGateway = true;
    }
  }
  return out;
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
