import { describe, it, expect } from "vitest";
import { toCanonical, stripOneM, ONE_M_SUFFIX } from "../../src/core/model-canonical.js";

describe("toCanonical (outbound /v1/models)", () => {
  it("maps Copilot's dotted opus id to the dashed canonical id + display + 1M badge", () => {
    expect(toCanonical("claude-opus-4.8")).toEqual({ id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" });
  });
  it("maps sonnet to dashed canonical + 1M", () => {
    expect(toCanonical("claude-sonnet-4.6")).toEqual({ id: "claude-sonnet-4-6[1m]", display_name: "Sonnet 4.6" });
  });
  it("maps haiku without a 1M badge (no 1M window)", () => {
    expect(toCanonical("claude-haiku-4.5")).toEqual({ id: "claude-haiku-4-5", display_name: "Haiku 4.5" });
  });
  it("dashes other claude families without a 1M badge", () => {
    expect(toCanonical("claude-sonnet-4.5")).toEqual({ id: "claude-sonnet-4-5", display_name: "Sonnet 4.5" });
    expect(toCanonical("claude-opus-4.7")).toEqual({ id: "claude-opus-4-7[1m]", display_name: "Opus 4.7" });
  });
  it("passes non-claude ids through untouched", () => {
    expect(toCanonical("gpt-4o")).toEqual({ id: "gpt-4o", display_name: "gpt-4o" });
    expect(toCanonical("o3-mini")).toEqual({ id: "o3-mini", display_name: "o3-mini" });
  });
});

describe("stripOneM (inbound)", () => {
  it("removes the [1m] picker suffix", () => {
    expect(stripOneM(`claude-opus-4-8${ONE_M_SUFFIX}`)).toBe("claude-opus-4-8");
  });
  it("leaves ids without the suffix unchanged", () => {
    expect(stripOneM("gpt-4o")).toBe("gpt-4o");
  });
});
