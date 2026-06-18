import type { CanonicalRequest } from "./canonical.js";

// A rough char/4 token estimate over a canonical request — message text plus tool schemas.
// It is not a model-exact tokenizer, but it is positive and monotonic in input size, which is
// enough to back /v1/messages/count_tokens so clients (Claude Code) can time auto-compaction.
// Mirrors agent-maestro's pragmatic "estimate then calibrate" approach to token counting.
export function estimateTokens(req: CanonicalRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    chars += m.role.length;
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_use") chars += b.name.length + JSON.stringify(b.input ?? {}).length;
      else if (b.type === "tool_result") chars += b.content.length;
    }
  }
  for (const t of req.tools ?? []) {
    chars += t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}
