import { describe, it, expect } from "vitest";
import { formatContextWindow } from "../../src/shared/format.js";

describe("formatContextWindow", () => {
  it("renders 1M, K, and raw values", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(900)).toBe("900");
  });
  it("returns empty string for unknown windows", () => {
    expect(formatContextWindow(undefined)).toBe("");
  });
});
