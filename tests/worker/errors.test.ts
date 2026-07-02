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
  it("detects an expired/revoked login and points to /login", () => {
    expect(errorHint("GitHub login expired — restart copilot-reverse to re-authenticate")).toMatch(/\/login/);
    expect(errorHint("authentication_error: token expired")).toMatch(/\/login/);
    expect(errorHint("copilot token exchange failed: 401")).toMatch(/\/login/);
    expect(errorHint("403 Forbidden")).toMatch(/\/login/);
  });
  it("detects an oversized request body (413) and suggests compacting / fewer screenshots", () => {
    expect(errorHint("copilot completion failed: 413 — Request Entity Too Large")).toMatch(/too large/i);
    expect(errorHint("copilot completion failed: 413 — Request Entity Too Large")).toMatch(/\/compact/);
    expect(errorHint("payload too large")).toMatch(/too large/i);
  });
});
