import { describe, it, expect } from "vitest";
import { normalizeEffort, reasoningFromEffort, reasoningFromThinking } from "../../src/core/reasoning.js";

describe("reasoning normalization", () => {
  it("passes through the canonical effort enum", () => {
    for (const e of ["none", "low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeEffort(e)).toBe(e);
    }
  });
  it("maps gemini's 'minimal' to low and unknown labels to medium", () => {
    expect(normalizeEffort("minimal")).toBe("low");
    expect(normalizeEffort("turbo")).toBe("medium");
  });
  it("returns undefined for empty/absent effort", () => {
    expect(normalizeEffort(undefined)).toBeUndefined();
    expect(normalizeEffort("")).toBeUndefined();
    expect(reasoningFromEffort(undefined)).toBeUndefined();
  });
  it("reasoningFromEffort wraps a normalized effort", () => {
    expect(reasoningFromEffort("HIGH")).toEqual({ effort: "high" });
  });

  it("buckets Anthropic thinking budgets onto efforts at the boundaries", () => {
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 1024 })).toEqual({ effort: "low" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 2048 })).toEqual({ effort: "low" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 2049 })).toEqual({ effort: "medium" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 8192 })).toEqual({ effort: "medium" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 16000 })).toEqual({ effort: "high" });
    expect(reasoningFromThinking({ type: "enabled", budget_tokens: 32000 })).toEqual({ effort: "max" });
  });
  it("treats enabled-without-budget as medium, disabled/absent as none", () => {
    expect(reasoningFromThinking({ type: "enabled" })).toEqual({ effort: "medium" });
    expect(reasoningFromThinking({ type: "disabled" })).toBeUndefined();
    expect(reasoningFromThinking(undefined)).toBeUndefined();
  });
});
