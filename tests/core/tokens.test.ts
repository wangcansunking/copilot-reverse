import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/core/tokens.js";
import type { CanonicalRequest } from "../../src/core/canonical.js";

const req = (text: string): CanonicalRequest => ({
  model: "m", stream: false, maxTokens: 1,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

describe("estimateTokens", () => {
  it("returns a positive estimate that grows with input size", () => {
    const small = estimateTokens(req("hi"));
    const big = estimateTokens(req("x".repeat(4000)));
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });

  it("counts tool schemas too", () => {
    const base = req("hi");
    const withTools: CanonicalRequest = { ...base, tools: [{ name: "t", parameters: { type: "object", properties: { a: { type: "string" } } } }] };
    expect(estimateTokens(withTools)).toBeGreaterThan(estimateTokens(base));
  });
});
