// Turn a raw upstream error message into an actionable hint (agent-maestro v2.8.1/v2.6.0:
// structured context-window-exceeded + model_not_supported guidance instead of a bare 400).
export function errorHint(message: string): string {
  const m = message.toLowerCase();
  // An expired/revoked GitHub login — tell the user to re-authenticate from inside the app.
  if (/login expired|authentication_error|token exchange failed|unauthorized|\b401\b|\b403\b/.test(m)) {
    return "GitHub login expired — run /login to sign in again";
  }
  if (/context_length_exceeded|prompt is too long|maximum context|too many tokens|context window/.test(m)) {
    return "context window exceeded — the conversation is too long; /compact or switch to a larger-context model";
  }
  // Copilot's gateway rejected the request body at the HTTP layer (byte size, not tokens) — most often a
  // long agentic session that accreted many screenshots. Context editing clears old ones automatically,
  // but a single huge turn can still trip it. Point the user at compaction / trimming attachments.
  if (/\b413\b|request entity too large|payload too large|entity too large/.test(m)) {
    return "request too large — the payload exceeded the gateway limit; /compact or send fewer/smaller images";
  }
  if (/not supported|unknown model|invalid model|model_not_found|does not support/.test(m)) {
    return "model not supported — run /model to pick an available one";
  }
  return "";
}
