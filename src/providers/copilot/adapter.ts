import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "../types.js";
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "../../core/canonical.js";
import { ToolCallExtractor, type ExtractEvent } from "../../core/tool-xml.js";
import { canonicalToResponsesBody, parseResponsesResult, streamResponses, RESPONSES_URL } from "./responses-upstream.js";

const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
interface TokenSource { get(): Promise<string> }
type EndpointsFor = (model: string) => string[];

// A /chat 400 whose body names one of these means "this model is responses-only" — retry on /responses
// once. Matches agent-maestro's safety net for models that drop /chat/completions from their endpoints.
const RESPONSES_HINT_RE = /unsupported_api_for_model|invalid_request_body|does not support|use the responses|model_not_supported/i;

// Canonical messages -> OpenAI wire messages (Copilot is OpenAI-shaped).
function toWireMessages(messages: CanonicalMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    // EACH tool_result becomes its own OpenAI `tool` message. Anthropic packs parallel results
    // into one user message; emitting only the first (the old bug) left later tool_use ids without
    // a matching tool_result -> Claude/Copilot 400 "tool_use ids ... without tool_result blocks".
    if (toolResults.length) {
      for (const tr of toolResults) out.push({ role: "tool", tool_call_id: tr.toolUseId, content: tr.content });
      continue;
    }
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
    const images = m.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
    const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    // With images, content becomes an OpenAI multipart array (text part + image_url parts); otherwise a string.
    let msgContent: any = text || null;
    if (images.length) {
      msgContent = [...(text ? [{ type: "text", text }] : []), ...images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }))];
    }
    const msg: any = { role: m.role, content: msgContent };
    if (toolUses.length) msg.tool_calls = toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } }));
    out.push(msg);
  }
  return out;
}

function buildBody(req: CanonicalRequest) {
  const body: any = { model: req.model, messages: toWireMessages(req.messages), stream: req.stream, temperature: req.temperature, max_tokens: req.maxTokens };
  if (req.stream) body.stream_options = { include_usage: true }; // ask Copilot for usage in the final frame
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return body;
}
function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", "editor-version": "vscode/1.95.0", "copilot-integration-id": "vscode-chat" };
}

// Copilot puts the real reason (bad model, oversized prompt, unsupported tool, …) in the body —
// surface it instead of a bare status code so failures are diagnosable.
async function errorDetail(res: Response): Promise<string> {
  try { const t = (await res.text()).trim(); return t ? ` — ${t.slice(0, 400)}` : ""; }
  catch { return ""; }
}

export class CopilotAdapter implements ProviderAdapter {
  readonly name = "copilot";
  // endpointsFor(model) -> the model's supported_endpoints (e.g. ["/responses"]). When known and it
  // omits /chat/completions, route to /responses; unknown ([]) keeps the chat path (with a 400 net).
  constructor(private tokenStore: TokenSource, private fetchFn: typeof fetch = fetch, private endpointsFor?: EndpointsFor) {}

  private usesResponses(model: string): boolean {
    const eps = this.endpointsFor?.(model);
    return !!eps && eps.length > 0 && !eps.includes("/chat/completions");
  }

  async complete(req: CanonicalRequest): Promise<CanonicalResponse> {
    if (this.usesResponses(req.model)) return this.completeResponses(req);
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: false })) });
    if (!res.ok) {
      const detail = await errorDetail(res);
      // Safety net: a responses-only model rejected on /chat — retry once on /responses.
      if (res.status === 400 && RESPONSES_HINT_RE.test(detail)) return this.completeResponses(req);
      throw new Error(`copilot completion failed: ${res.status}${detail}`);
    }
    const data = (await res.json()) as any;
    const choice = data.choices[0];
    const content: ContentBlock[] = [];
    // Recover inline-XML tool calls in non-stream replies too (same reason as the stream path).
    let xmlTool = false;
    if (choice.message.content) {
      const ex = new ToolCallExtractor();
      for (const ev of [...ex.feed(choice.message.content), ...ex.flush()]) {
        if (ev.kind === "text") { if (ev.text) content.push({ type: "text", text: ev.text }); }
        else { xmlTool = true; content.push({ type: "tool_use", id: ev.tool.id, name: ev.tool.name, input: ev.tool.input }); }
      }
    }
    for (const tc of choice.message.tool_calls ?? []) content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    return {
      id: data.id ?? `cmpl-${randomUUID().replace(/-/g, "")}`, model: req.model, content,
      finishReason: choice.finish_reason === "tool_calls" || xmlTool ? "tool_use" : choice.finish_reason === "length" ? "length" : "stop",
      usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  // /responses variants — used for responses-only models and as the /chat 400 safety-net target.
  private async completeResponses(req: CanonicalRequest): Promise<CanonicalResponse> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(RESPONSES_URL, { method: "POST", headers: headers(token), body: JSON.stringify(canonicalToResponsesBody({ ...req, stream: false })) });
    if (!res.ok) throw new Error(`copilot responses failed: ${res.status}${await errorDetail(res)}`);
    return { ...parseResponsesResult(await res.json()), model: req.model };
  }
  private async *streamResponsesReq(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(RESPONSES_URL, { method: "POST", headers: headers(token), body: JSON.stringify(canonicalToResponsesBody({ ...req, stream: true })) });
    if (!res.ok || !res.body) throw new Error(`copilot responses stream failed: ${res.status}${await errorDetail(res)}`);
    yield* streamResponses(res);
  }

  async *stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    if (this.usesResponses(req.model)) { yield* this.streamResponsesReq(req); return; }
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: true })) });
    if (!res.ok || !res.body) {
      const detail = await errorDetail(res);
      if (res.status === 400 && RESPONSES_HINT_RE.test(detail)) { yield* this.streamResponsesReq(req); return; }
      throw new Error(`copilot stream failed: ${res.status}${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const startedTools = new Set<number>();
    let buffer = "";
    let finishReason: CanonicalResponse["finishReason"] = "stop";
    let usage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined;
    const mapFinish = (f: string | null | undefined): CanonicalResponse["finishReason"] =>
      f === "tool_calls" ? "tool_use" : f === "length" ? "length" : "stop";

    // Some models emit a tool call as inline XML text instead of native tool_calls (more likely on
    // long/tool-heavy turns) — and they do it even when THIS request declared no tools (a follow-up
    // turn, or a model that ignores the tools field). Always run assistant text through the extractor;
    // it only captures on the distinctive `<invoke>`/`<function_calls>` sentinel and flushes anything
    // unparseable back as text, so plain prose is unaffected.
    const extractor = new ToolCallExtractor();
    let extractedTool = false;
    let extIdx = 100; // separate index space so recovered tools never collide with native tool_calls
    const toChunks = (events: ExtractEvent[]): CanonicalChunk[] => {
      const out: CanonicalChunk[] = [];
      for (const ev of events) {
        if (ev.kind === "text") { if (ev.text) out.push({ kind: "text", delta: ev.text, done: false }); continue; }
        const index = extIdx++;
        extractedTool = true;
        out.push({ kind: "tool_use_start", index, id: ev.tool.id, name: ev.tool.name, done: false });
        out.push({ kind: "tool_use_delta", index, argsDelta: JSON.stringify(ev.tool.input), done: false });
      }
      return out;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          if (extractor) for (const ch of toChunks(extractor.flush())) yield ch;
          if (extractedTool && finishReason === "stop") finishReason = "tool_use";
          yield { kind: "done", done: true, finishReason, usage };
          return;
        }
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        // Copilot sends a final frame with empty choices carrying usage (stream_options.include_usage).
        if (json.usage) usage = { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0, cachedTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0 };
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = mapFinish(choice.finish_reason);
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.content) {
          if (extractor) { for (const ch of toChunks(extractor.feed(delta.content))) yield ch; }
          else yield { kind: "text", delta: delta.content, done: false };
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!startedTools.has(idx) && tc.function?.name) { startedTools.add(idx); yield { kind: "tool_use_start", index: idx, id: tc.id ?? `call_${idx}`, name: tc.function.name, done: false }; }
          if (tc.function?.arguments) yield { kind: "tool_use_delta", index: idx, argsDelta: tc.function.arguments, done: false };
        }
      }
    }
    if (extractor) for (const ch of toChunks(extractor.flush())) yield ch;
    if (extractedTool && finishReason === "stop") finishReason = "tool_use";
    yield { kind: "done", done: true, finishReason, usage };
  }
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
