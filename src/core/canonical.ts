export interface TextBlock { type: "text"; text: string }
export interface ImageBlock { type: "image"; dataUrl: string } // full data URI, e.g. data:image/png;base64,...
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; toolUseId: string; content: string }
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}
export interface CanonicalTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}
export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: CanonicalTool[];
}
export interface CanonicalResponse {
  id: string;
  model: string;
  content: ContentBlock[]; // text and/or tool_use
  finishReason: "stop" | "length" | "tool_use" | "error";
  usage: { promptTokens: number; completionTokens: number };
}

// Streaming deltas. Tool-call deltas accumulate by index in the translator.
export type CanonicalChunk =
  | { kind: "text"; delta: string; done: false }
  | { kind: "tool_use_start"; index: number; id: string; name: string; done: false }
  | { kind: "tool_use_delta"; index: number; argsDelta: string; done: false }
  | { kind: "done"; done: true; finishReason?: CanonicalResponse["finishReason"]; usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number } };

export function textContent(s: string): ContentBlock[] {
  return [{ type: "text", text: s }];
}
export function joinText(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
}
