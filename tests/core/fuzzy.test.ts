import { describe, it, expect } from "vitest";
import { bestModelMatch } from "../../src/core/fuzzy.js";

const available = ["claude-opus-4.8", "claude-sonnet-4.6", "gpt-4o", "gpt-5.5", "o3-mini"];

describe("bestModelMatch", () => {
  it("returns an exact match unchanged", () => {
    expect(bestModelMatch("gpt-4o", available)).toBe("gpt-4o");
  });
  it("maps a dash/date-suffixed Anthropic id to the Copilot dotted id", () => {
    expect(bestModelMatch("claude-opus-4-8", available)).toBe("claude-opus-4.8");
    expect(bestModelMatch("claude-opus-4-8-20251101", available)).toBe("claude-opus-4.8");
    expect(bestModelMatch("claude-sonnet-4-6-20250929", available)).toBe("claude-sonnet-4.6");
  });
  it("returns null when nothing is close enough", () => {
    expect(bestModelMatch("gemini-3.5-flash", available)).toBeNull();
    expect(bestModelMatch("totally-unknown-xyz", available)).toBeNull();
  });
});
