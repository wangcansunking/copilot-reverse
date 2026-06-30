import { describe, it, expect } from "vitest";
import { buildChangeBannerLines, pickHeadline } from "../../src/tui/whats-new.js";

const entry = (version: string, summaries: string[]) => ({ version, date: "2026-06-30", summary: summaries[0], summaries });

describe("pickHeadline", () => {
  it("prefers a feat over a fix even when the fix comes first", () => {
    expect(pickHeadline(["fix: plumbing.", "feat: access modes.", "chore: bump."])).toBe("feat: access modes.");
  });
  it("treats untyped prose as feature-grade (above a fix)", () => {
    expect(pickHeadline(["fix: small.", "Map model ids to canonical ids."])).toBe("Map model ids to canonical ids.");
  });
  it("breaks ties by length (the more substantial write-up wins)", () => {
    expect(pickHeadline(["feat: short.", "feat: a much longer and more detailed summary."])).toBe("feat: a much longer and more detailed summary.");
  });
  it("ranks perf as a capability, above fix", () => {
    expect(pickHeadline(["fix: x.", "perf: faster stream."])).toBe("perf: faster stream.");
  });
  it("returns undefined for no summaries", () => {
    expect(pickHeadline([])).toBeUndefined();
  });
});

describe("buildChangeBannerLines", () => {
  it("shows ONE line per version (newest first), each the version's main change, with a pointer", () => {
    const out = buildChangeBannerLines([
      entry("0.9.0", ["fix(release): plumbing.", "feat(tui): metrics card.", "feat(network): access modes."]),
      entry("0.8.0", ["Map model ids to canonical ids."]),
      entry("0.7.0", ["feat(tui): token usage + cost."]),
    ]);
    expect(out).toEqual([
      "• v0.9.0 — feat(network): access modes.",     // two feats tie on type → longer one wins
      "• v0.8.0 — Map model ids to canonical ids.",
      "• v0.7.0 — feat(tui): token usage + cost.",
      "• type /changes for the full list",
    ]);
  });
  it("picks the headline feature for a version, not the first (plumbing) paragraph", () => {
    const out = buildChangeBannerLines([
      entry("0.9.0", ["fix(release): update CHANGELOG before build.", "feat(network): explicit access modes — localhost vs LAN."]),
    ]);
    expect(out[0]).toBe("• v0.9.0 — feat(network): explicit access modes — localhost vs LAN.");
  });
  it("caps at `max` versions", () => {
    const out = buildChangeBannerLines([entry("0.4.0", ["a."]), entry("0.3.0", ["b."]), entry("0.2.0", ["c."]), entry("0.1.0", ["d."])], 3);
    expect(out).toEqual(["• v0.4.0 — a.", "• v0.3.0 — b.", "• v0.2.0 — c.", "• type /changes for the full list"]);
  });
  it("truncates a long summary", () => {
    const long = "feat: " + "x".repeat(200);
    const [first] = buildChangeBannerLines([entry("1.0.0", [long])]);
    expect(first.length).toBeLessThan(100);
    expect(first.endsWith("…")).toBe(true);
  });
  it("returns nothing when there are no changes (banner is then omitted)", () => {
    expect(buildChangeBannerLines([])).toEqual([]);
  });
});
