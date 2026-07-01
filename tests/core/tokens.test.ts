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

  // An image's inline data URL is billed by Copilot as plain text (~char/4). If we didn't count it,
  // count_tokens would under-report by millions and Claude Code would ship an oversized prompt into a
  // model_max_prompt_tokens_exceeded 502. The estimate MUST grow with the image payload's byte size.
  it("counts image data-URL bytes", () => {
    const base = req("hi");
    const bigDataUrl = `data:image/png;base64,${"A".repeat(40000)}`;
    const withImage: CanonicalRequest = {
      ...base,
      messages: [{ role: "user", content: [{ type: "image", dataUrl: bigDataUrl }] }],
    };
    const est = estimateTokens(withImage);
    expect(est).toBeGreaterThan(estimateTokens(base));
    // ~char/4 of the data URL — proves it scales with payload size, not a flat constant.
    expect(est).toBeGreaterThan(9000);
  });
});
