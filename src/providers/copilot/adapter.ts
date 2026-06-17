import type { ProviderAdapter } from "../types.js";
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "../../core/canonical.js";

const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
interface TokenSource { get(): Promise<string> }

// Canonical messages -> OpenAI wire messages (Copilot is OpenAI-shaped).
function toWireMessages(messages: CanonicalMessage[]) {
  return messages.map((m) => {
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
    const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const toolResult = m.content.find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    if (m.role === "tool" && toolResult) return { role: "tool", tool_call_id: toolResult.toolUseId, content: toolResult.content };
    const out: any = { role: m.role, content: text || null };
    if (toolUses.length) out.tool_calls = toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } }));
    return out;
  });
}

function buildBody(req: CanonicalRequest) {
  const body: any = { model: req.model, messages: toWireMessages(req.messages), stream: req.stream, temperature: req.temperature, max_tokens: req.maxTokens };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return body;
}
function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", "editor-version": "vscode/1.95.0", "copilot-integration-id": "vscode-chat" };
}

export class CopilotAdapter implements ProviderAdapter {
  readonly name = "copilot";
  constructor(private tokenStore: TokenSource, private fetchFn: typeof fetch = fetch) {}

  async complete(req: CanonicalRequest): Promise<CanonicalResponse> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: false })) });
    if (!res.ok) throw new Error(`copilot completion failed: ${res.status}`);
    const data = (await res.json()) as any;
    const choice = data.choices[0];
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of choice.message.tool_calls ?? []) content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    return {
      id: data.id ?? "cmpl", model: req.model, content,
      finishReason: choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "length" : "stop",
      usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  async *stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: true })) });
    if (!res.ok || !res.body) throw new Error(`copilot stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const startedTools = new Set<number>();
    let buffer = "";
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
        if (payload === "[DONE]") { yield { kind: "done", done: true, finishReason: "stop" }; return; }
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { kind: "text", delta: delta.content, done: false };
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!startedTools.has(idx) && tc.function?.name) { startedTools.add(idx); yield { kind: "tool_use_start", index: idx, id: tc.id ?? `call_${idx}`, name: tc.function.name, done: false }; }
          if (tc.function?.arguments) yield { kind: "tool_use_delta", index: idx, argsDelta: tc.function.arguments, done: false };
        }
      }
    }
    yield { kind: "done", done: true, finishReason: "stop" };
  }
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
