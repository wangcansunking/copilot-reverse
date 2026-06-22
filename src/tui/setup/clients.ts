export interface Endpoint { host: string; port: number; apiKey: string }
export interface ClientSetup { env: Record<string, string>; instructions: string }

export function claudeCodeConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}`;
  return {
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: e.apiKey },
    instructions: `Set these env vars for Claude Code:\n  ANTHROPIC_BASE_URL=${base}\n  ANTHROPIC_API_KEY=${e.apiKey}`,
  };
}
// The full env maestro writes into Claude Code's settings.json. Beyond the endpoint, it tells
// Claude Code the selected model's real context window (CLAUDE_CODE_AUTO_COMPACT_WINDOW) so the
// client stops assuming the default 200K and compacts at the right point — without this a 1M
// model (e.g. claude-opus-4.8) shows "context 100%" far too early. Mirrors agent-maestro.
export function claudeMaestroEnv(base: string, apiKey: string, model: string, contextWindow?: number): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
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
