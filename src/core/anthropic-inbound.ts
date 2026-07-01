import type { CanonicalRequest, CanonicalResponse, CanonicalMessage, ContentBlock } from "./canonical.js";
import { GATEWAY_TOOL_DEFS, isGatewayTool } from "./server-tools.js";
import { resolveReasoning } from "./reasoning.js";

interface AnthropicImageSource { type: "base64" | "url"; media_type?: string; data?: string; url?: string }
interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; source?: AnthropicImageSource; thinking?: string; signature?: string }
interface AnthropicMsg { role: "user" | "assistant"; content: string | AnthropicBlock[] }
// Custom tools carry an input_schema. Server-side tools (web_search, web_fetch, bash, computer, …)
// instead carry a dated `type` (e.g. "web_search_20250305") and a bare `name`, with no schema.
interface AnthropicTool { type?: string; name: string; description?: string; input_schema?: Record<string, unknown> }
// `thinking` gates extended reasoning: { type: "enabled"|"disabled"|"adaptive", budget_tokens? }.
// Legacy clients sent a budget; modern ones (Opus 4.7/4.8, Claude Code 2.1.x) send `adaptive` with the
// effort in a separate top-level `output_config.effort`. See resolveReasoning for precedence.
interface AnthropicThinking { type?: string; budget_tokens?: number }
interface AnthropicOutputConfig { effort?: string }
interface AnthropicRequest {
  model: string; max_tokens: number; stream?: boolean; temperature?: number;
  system?: string | AnthropicBlock[]; tools?: AnthropicTool[]; messages: AnthropicMsg[];
  thinking?: AnthropicThinking;
  output_config?: AnthropicOutputConfig;
}

// The Anthropic `system` field may be a plain string or an array of text blocks (the Claude Code
// SDK sends blocks with cache_control). Flatten either shape to a string — otherwise it stringifies
// to "[object Object]" and the model gets garbage instructions.
function systemText(system: string | AnthropicBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((b) => b.type === "text" && b.text != null).map((b) => b.text).join("");
}

// Normalize an Anthropic image source (base64 `media_type`+`data`, or a `url`) to a full data URL.
function imageSourceToDataUrl(source: AnthropicImageSource): string {
  return source.type === "url" && source.url
    ? source.url
    : `data:${source.media_type ?? "image/png"};base64,${source.data ?? ""}`;
}

// A tool_result's `content` may itself be a string, or an array of blocks that can include images
// (Anthropic + MCP tools can return a screenshot). Split it into the text (joined) and the images
// (as data URLs), so an image returned BY a tool is preserved as a real image the resize + token
// paths can see — instead of being JSON.stringify'd into the text and billed as raw base64.
function splitToolResultContent(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? "" : JSON.stringify(content), images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of content as AnthropicBlock[]) {
    if (part?.type === "text" && part.text != null) texts.push(part.text);
    else if (part?.type === "image" && part.source) images.push(imageSourceToDataUrl(part.source));
    else if (part != null) texts.push(JSON.stringify(part)); // preserve any other structured part as text
  }
  return { text: texts.join(""), images };
}

function blocksToCanonical(content: string | AnthropicBlock[]): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text != null) out.push({ type: "text", text: b.text });
    else if (b.type === "image" && b.source) out.push({ type: "image", dataUrl: imageSourceToDataUrl(b.source) });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id!, name: b.name!, input: b.input });
    else if (b.type === "tool_result") {
      const { text, images } = splitToolResultContent(b.content);
      out.push({ type: "tool_result", toolUseId: b.tool_use_id!, content: text, ...(images.length ? { images } : {}) });
    }
    // A prior assistant thinking block round-trips so the opaque continuation token (signature) can be
    // echoed upstream, preserving the model's reasoning context across tool-call turns. redacted_thinking
    // (encrypted-only, no text) is carried the same way via its data field.
    else if (b.type === "thinking") out.push({ type: "thinking", text: b.thinking ?? "", opaque: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: "thinking", text: "", opaque: (b as { data?: string }).data });
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
    reasoning: resolveReasoning(req.output_config, req.thinking),
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
    // A thinking block carries the chain-of-thought plus the opaque continuation token as `signature`
    // (Anthropic's extended-thinking shape), so a non-stream client renders + can echo it back.
    b.type === "thinking" ? { type: "thinking", thinking: b.text, ...(b.opaque ? { signature: b.opaque } : {}) } :
    { type: "text", text: "" });
  const stop = r.finishReason === "tool_use" ? "tool_use" : r.finishReason === "length" ? "max_tokens" : "end_turn";
  return {
    id: r.id, type: "message" as const, role: "assistant" as const, model: r.model,
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: r.usage.promptTokens, output_tokens: r.usage.completionTokens },
  };
}
