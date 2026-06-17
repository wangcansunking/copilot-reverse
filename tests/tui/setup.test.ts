import { describe, it, expect } from "vitest";
import { claudeCodeConfig, codexConfig } from "../../src/tui/setup/clients.js";

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
