import { describe, it, expect } from "vitest";
import { buildChangeBannerLines } from "../../src/tui/whats-new.js";

const entry = (version: string, summaries: string[]) => ({ version, date: "2026-06-30", summary: summaries[0], summaries });

describe("buildChangeBannerLines", () => {
  it("flattens across releases, newest-first, capped, with a /changes pointer", () => {
    const out = buildChangeBannerLines([
      entry("0.9.0", ["fix: plumbing.", "feat: metrics card.", "feat: access modes."]),
      entry("0.8.0", ["feat: model id mapping."]),
    ]);
    expect(out).toEqual([
      "• v0.9.0 — fix: plumbing.",
      "• v0.9.0 — feat: metrics card.",
      "• v0.9.0 — feat: access modes.",
      "• type /changes for the full list",
    ]);
  });
  it("pulls from older releases when the newest has fewer than `max` changes", () => {
    const out = buildChangeBannerLines([entry("0.9.0", ["only one."]), entry("0.8.0", ["older a.", "older b."])]);
    expect(out.slice(0, 3)).toEqual(["• v0.9.0 — only one.", "• v0.8.0 — older a.", "• v0.8.0 — older b."]);
  });
  it("truncates a long summary", () => {
    const long = "x".repeat(200);
    const [first] = buildChangeBannerLines([entry("1.0.0", [long])]);
    expect(first.length).toBeLessThan(100);
    expect(first.endsWith("…")).toBe(true);
  });
  it("returns nothing when there are no changes (banner is then omitted)", () => {
    expect(buildChangeBannerLines([])).toEqual([]);
  });
  it("respects a custom max", () => {
    const out = buildChangeBannerLines([entry("0.9.0", ["a.", "b.", "c.", "d."])], 2);
    expect(out).toEqual(["• v0.9.0 — a.", "• v0.9.0 — b.", "• type /changes for the full list"]);
  });
});
