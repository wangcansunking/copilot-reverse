import { describe, it, expect } from "vitest";
import { errorHint } from "../../src/worker/errors.js";

describe("errorHint", () => {
  it("explains a context-window overflow", () => {
    expect(errorHint("copilot completion failed: 400 — prompt is too long: 250000 tokens")).toMatch(/context window/i);
    expect(errorHint("context_length_exceeded")).toMatch(/context window/i);
  });
  it("explains an unsupported model", () => {
    expect(errorHint("the model `foo` does not support tools / is not supported")).toMatch(/\/model/);
  });
  it("returns empty for unknown errors", () => {
    expect(errorHint("some random failure")).toBe("");
  });
  it("matches several context-overflow phrasings", () => {
    expect(errorHint("maximum context length is 8192")).toMatch(/context window/i);
    expect(errorHint("too many tokens in the prompt")).toMatch(/context window/i);
  });
  it("matches several unsupported-model phrasings", () => {
    expect(errorHint("model_not_found: nope")).toMatch(/\/model/);
    expect(errorHint("invalid model specified")).toMatch(/\/model/);
  });
});
