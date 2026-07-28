export interface Endpoint { host: string; port: number; apiKey: string }
export interface ClientSetup { env: Record<string, string>; instructions: string }
import { toCanonical, stripOneM } from "../../core/model-canonical.js";

export function claudeCodeConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/anthropic`;
  return {
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: e.apiKey },
    instructions: `Set these env vars for Claude Code:\n  ANTHROPIC_BASE_URL=${base}\n  ANTHROPIC_API_KEY=${e.apiKey}`,
  };
}
export const ONE_M_SUFFIX = "[1m]";

// Claude Code switches to its 1M window only when ANTHROPIC_MODEL ends with `[1m]`, and only matches
// the model to its native picker entry when the id is the DASHED canonical form it knows
// (claude-opus-4-8, not Copilot's dotted claude-opus-4.8). Route the default model through toCanonical
// so it's both dashed and 1M-badged; for non-claude ids keep the legacy context-window suffix. The
// proxy strips [1m] + fuzzy-maps back to Copilot before forwarding.
//
// The 1M decision is driven by the REAL context window we were handed (fetchModelLimits), in the same
// ~800K..1.5M band agent-maestro uses, so a newly-shipped 1M model (claude-opus-5, or any future
// family) gets [1m] with zero list edits. Only when the window is unknown (discovery not yet resolved /
// no token) do we fall back to toCanonical's hardcoded DEFAULT_ONE_M_MODELS, so known models still badge.
export function withClaude1mSuffix(model: string, contextWindow?: number): string {
  const inBand = contextWindow != null && contextWindow > 800_000 && contextWindow < 1_500_000;
  // Strip any suffix the caller already applied so we never double-append when re-canonicalizing.
  const bare = stripOneM(model);
  if (bare.startsWith("claude-")) return toCanonical(bare, contextWindow != null ? () => inBand : undefined).id;
  return inBand && !model.endsWith(ONE_M_SUFFIX) ? `${model}${ONE_M_SUFFIX}` : model;
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
    // Populate Claude Code's /model picker from our /anthropic/v1/models so the user can switch
    // models natively. Coexists with ANTHROPIC_MODEL (which stays the 1M default — it does NOT lock
    // the picker). Claude Code >=2.1.129 only; older builds ignore it. Picker lists claude* ids.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
}

export function codexConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/openai`;
  return {
    env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: e.apiKey },
    instructions: `Set these env vars for Codex / OpenAI clients:\n  OPENAI_BASE_URL=${base}\n  OPENAI_API_KEY=${e.apiKey}`,
  };
}
