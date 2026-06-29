import { describe, it, expect } from "vitest";
import { formatContextWindow, loadingVerb, LOADING_VERBS, formatModelList, oneLine } from "../../src/shared/format.js";

describe("oneLine", () => {
  it("collapses newlines and whitespace runs into single spaces", () => {
    expect(oneLine("a\nb\r\n  c\t\td")).toBe("a b c d");
  });
  it("flattens a multi-line HTML error page into one contained line", () => {
    const html = '<!DOCTYPE html>\n<html>\n  <head><style>body { color: red }</style></head>\n  <body>502 Bad Gateway</body>\n</html>';
    const out = oneLine(html);
    expect(out).not.toMatch(/\n/);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
  });
  it("trims and truncates with an ellipsis past the limit", () => {
    expect(oneLine("   hi   ")).toBe("hi");
    const out = oneLine("x".repeat(200), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });
  it("passes short single-line strings through unchanged", () => {
    expect(oneLine("already clean")).toBe("already clean");
  });
  it("handles empty / nullish input", () => {
    expect(oneLine("")).toBe("");
    expect(oneLine(undefined)).toBe("");
  });
});

describe("formatModelList", () => {
  it("lists ids with their context windows, omitting unknown ones", () => {
    expect(formatModelList(["gpt-4o", "mystery"], { "gpt-4o": 128000 })).toBe("- gpt-4o (128K)\n- mystery");
  });
  it("handles the empty case", () => {
    expect(formatModelList([])).toBe("(no models found)");
  });
});

describe("loadingVerb", () => {
  it("holds a verb for a 3s window, then rotates to the next", () => {
    expect(loadingVerb(0)).toBe(loadingVerb(2999));
    expect(loadingVerb(0)).not.toBe(loadingVerb(3000));
    expect(loadingVerb(3000)).toBe(LOADING_VERBS[1]);
  });
  it("wraps around the verb list", () => {
    expect(loadingVerb(LOADING_VERBS.length * 3000)).toBe(LOADING_VERBS[0]);
  });
});

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
