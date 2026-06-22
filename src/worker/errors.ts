// Turn a raw upstream error message into an actionable hint (agent-maestro v2.8.1/v2.6.0:
// structured context-window-exceeded + model_not_supported guidance instead of a bare 400).
export function errorHint(message: string): string {
  const m = message.toLowerCase();
  if (/context_length_exceeded|prompt is too long|maximum context|too many tokens|context window/.test(m)) {
    return "context window exceeded — the conversation is too long; /compact or switch to a larger-context model";
  }
  if (/not supported|unknown model|invalid model|model_not_found|does not support/.test(m)) {
    return "model not supported — run /model to pick an available one";
  }
  return "";
}
