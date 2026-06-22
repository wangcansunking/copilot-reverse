export interface Endpoint { host: string; port: number; apiKey: string }
export interface ClientSetup { env: Record<string, string>; instructions: string }

export function claudeCodeConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}`;
  return {
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: e.apiKey },
    instructions: `Set these env vars for Claude Code:\n  ANTHROPIC_BASE_URL=${base}\n  ANTHROPIC_API_KEY=${e.apiKey}`,
  };
}
export const ONE_M_SUFFIX = "[1m]";

// Claude Code switches to its 1M context window only when ANTHROPIC_MODEL ends with `[1m]` — that
// suffix is its built-in signal for a 1M model. Mirror agent-maestro: append it for models whose
// window is in the ~1M band (800K..1.5M). Without it Claude Code assumes 200K -> "context 100%"
// and /compact fails. The proxy strips the suffix again before forwarding to Copilot.
export function withClaude1mSuffix(model: string, contextWindow?: number): string {
  return contextWindow && contextWindow > 800_000 && contextWindow < 1_500_000 && !model.endsWith(ONE_M_SUFFIX)
    ? `${model}${ONE_M_SUFFIX}`
    : model;
}

// The full env copilot-reverse writes into Claude Code's settings.json. Beyond the endpoint, it tells
// Claude Code the selected model's real context window (via the [1m] model suffix and
// CLAUDE_CODE_AUTO_COMPACT_WINDOW) so the client stops assuming the default 200K. Mirrors agent-maestro.
export function claudeCopilotReverseEnv(base: string, apiKey: string, model: string, contextWindow?: number): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: withClaude1mSuffix(model, contextWindow),
    ...(contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow) } : {}),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0", // keep prompt caching working on a non-Anthropic gateway
  };
}

export function codexConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/v1`;
  return {
    env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: e.apiKey },
    instructions: `Set these env vars for Codex / OpenAI clients:\n  OPENAI_BASE_URL=${base}\n  OPENAI_API_KEY=${e.apiKey}`,
  };
}
