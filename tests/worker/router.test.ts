import { describe, it, expect } from "vitest";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const fake: ProviderAdapter = { name: "copilot", complete: async () => ({ id: "x", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }), async *stream() {} };

describe("Router", () => {
  it("maps model names via modelMap with * fallback", () => {
    const r = new Router([fake], { "claude-opus-4-8": "gpt-4o", "*": "gpt-4o-mini" });
    expect(r.resolveModel("claude-opus-4-8")).toBe("gpt-4o");
    expect(r.resolveModel("whatever")).toBe("gpt-4o-mini");
  });
  it("returns the only provider", () => {
    expect(new Router([fake], { "*": "gpt-4o" }).pick("x").name).toBe("copilot");
  });
  it("throws with no providers", () => {
    expect(() => new Router([], { "*": "gpt-4o" }).pick("x")).toThrow(/no provider/i);
  });
});
