import { describe, it, expect } from "vitest";
import { Router } from "../../src/worker/router.js";
import { toCanonical } from "../../src/core/model-canonical.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const fake: ProviderAdapter = { name: "copilot", complete: async () => ({ id: "x", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }), async *stream() {} };

describe("Router", () => {
  it("maps model names via modelMap with * fallback", () => {
    const r = new Router([fake], { "claude-opus-4-8": "gpt-4o", "*": "gpt-4o-mini" });
    expect(r.resolveModel("claude-opus-4-8")).toBe("gpt-4o");
    expect(r.resolveModel("whatever")).toBe("gpt-4o-mini");
  });
  it("fuzzy-matches a near-miss model id to an available Copilot model", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-opus-4.8", "gpt-4o"]);
    expect(r.resolveModel("claude-opus-4-8-20251101")).toBe("claude-opus-4.8");
    expect(r.resolveModel("gpt-4o")).toBe("gpt-4o"); // exact stays
    expect(r.resolveModel("unknown-xyz")).toBe("unknown-xyz"); // no match -> passthrough
  });
  it("strips Claude Code's [1m] suffix before forwarding to Copilot", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-opus-4.8", "gpt-4o"]);
    expect(r.resolveModel("claude-opus-4.8[1m]")).toBe("claude-opus-4.8");
  });
  it("round-trips every advertised canonical id back to its Copilot model", () => {
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-opus-4.8", "claude-sonnet-4.6", "claude-sonnet-5", "claude-haiku-4-5", "gpt-4o"]);
    for (const real of ["claude-opus-4.8", "claude-sonnet-4.6", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(r.resolveModel(toCanonical(real).id)).toBe(real);
    }
  });
  it("round-trips a 1M-badged single-segment id (sonnet-5[1m]) back to its Copilot model", () => {
    // The picker advertises claude-sonnet-5[1m] when the oracle marks it 1M; the inbound path must strip
    // [1m] and resolve it back to the dotted upstream id, exactly as it does for the opus/sonnet families.
    const r = new Router([fake], {});
    r.setAvailableModels(["claude-sonnet-5", "gpt-4o"]);
    expect(r.resolveModel(toCanonical("claude-sonnet-5", () => true).id)).toBe("claude-sonnet-5");
  });
  it("returns the only provider", () => {
    expect(new Router([fake], { "*": "gpt-4o" }).pick("x").name).toBe("copilot");
  });
  it("throws with no providers", () => {
    expect(() => new Router([], { "*": "gpt-4o" }).pick("x")).toThrow(/no provider/i);
  });
});
