import { describe, it, expect } from "vitest";
import { claudeCodeConfig, codexConfig, claudeMaestroEnv } from "../../src/tui/setup/clients.js";

describe("claudeMaestroEnv", () => {
  it("writes the model's context window so Claude Code knows it's a 1M model", () => {
    const env = claudeMaestroEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000);
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.8");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("80");
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
  });
  it("omits the window when it's unknown", () => {
    const env = claudeMaestroEnv("http://x", "k", "gpt-4o");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});

describe("client setup", () => {
  it("claude code points ANTHROPIC_BASE_URL at the worker", () => {
    const c = claudeCodeConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7891");
    expect(c.env.ANTHROPIC_API_KEY).toBe("k");
    expect(c.instructions).toMatch(/ANTHROPIC_BASE_URL/);
  });
  it("codex points at the OpenAI endpoint", () => {
    const c = codexConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:7891/v1");
  });
});
