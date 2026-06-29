import { describe, it, expect } from "vitest";
import { claudeCodeConfig, codexConfig, claudeCopilotReverseEnv, withClaude1mSuffix } from "../../src/tui/setup/clients.js";

describe("withClaude1mSuffix", () => {
  it("appends [1m] for a ~1M model so Claude Code uses its 1M window", () => {
    expect(withClaude1mSuffix("claude-opus-4.8", 1_000_000)).toBe("claude-opus-4.8[1m]");
    expect(withClaude1mSuffix("claude-opus-4.8", 936_000)).toBe("claude-opus-4.8[1m]");
  });
  it("leaves sub-1M and unknown models alone, and doesn't double-append", () => {
    expect(withClaude1mSuffix("claude-opus-4.5", 200_000)).toBe("claude-opus-4.5");
    expect(withClaude1mSuffix("gpt-4o")).toBe("gpt-4o");
    expect(withClaude1mSuffix("claude-opus-4.8[1m]", 1_000_000)).toBe("claude-opus-4.8[1m]");
  });
});

describe("claudeCopilotReverseEnv", () => {
  it("writes the [1m] model + window so Claude Code knows it's a 1M model", () => {
    const env = claudeCopilotReverseEnv("http://127.0.0.1:7891", "k", "claude-opus-4.8", 1_000_000);
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.8[1m]");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("80");
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1"); // /model picker is populated, not locked
  });
  it("omits the window/suffix when it's unknown", () => {
    const env = claudeCopilotReverseEnv("http://x", "k", "gpt-4o");
    expect(env.ANTHROPIC_MODEL).toBe("gpt-4o");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});

describe("client setup", () => {
  it("claude code points ANTHROPIC_BASE_URL at the worker's /anthropic prefix", () => {
    const c = claudeCodeConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7891/anthropic");
    expect(c.env.ANTHROPIC_API_KEY).toBe("k");
    expect(c.instructions).toMatch(/ANTHROPIC_BASE_URL/);
  });
  it("codex points at the worker's /openai prefix", () => {
    const c = codexConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:7891/openai");
  });
});
