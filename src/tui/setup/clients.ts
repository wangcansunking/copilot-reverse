export interface Endpoint { host: string; port: number; apiKey: string }
export interface ClientSetup { env: Record<string, string>; instructions: string }

export function claudeCodeConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}`;
  return {
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: e.apiKey },
    instructions: `Set these env vars for Claude Code:\n  ANTHROPIC_BASE_URL=${base}\n  ANTHROPIC_API_KEY=${e.apiKey}`,
  };
}
export function codexConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/v1`;
  return {
    env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: e.apiKey },
    instructions: `Set these env vars for Codex / OpenAI clients:\n  OPENAI_BASE_URL=${base}\n  OPENAI_API_KEY=${e.apiKey}`,
  };
}
