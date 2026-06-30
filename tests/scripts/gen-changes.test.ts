import { describe, it, expect } from "vitest";

// Mirrors the parser in scripts/gen-changes.mjs (kept simple; the script is the source of truth).
// Guards the contract: each "## vX.Y.Z — DATE" + its paragraphs becomes one entry, newest-first,
// capped. A bundled release (several changesets) yields several `summaries`; `summary` is the first.
function parseChangelog(text: string, recent = 10) {
  const entries: { version: string; date: string; summary: string; summaries: string[] }[] = [];
  for (const block of text.split(/^## v/m).slice(1)) {
    const m = block.match(/^(\d+\.\d+\.\d+) — (\S+)\n+([\s\S]*)$/);
    if (!m) continue;
    const summaries = m[3].split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!summaries.length) continue;
    entries.push({ version: m[1], date: m[2], summary: summaries[0], summaries });
    if (entries.length >= recent) break;
  }
  return entries;
}

describe("changelog parser (gen-changes)", () => {
  const sample = ["## v0.5.5 — 2026-06-29", "", "ci: gate PRs.", "", "## v0.5.4 — 2026-06-29", "", "fix: loop.", ""].join("\n");
  it("captures version, date, summary newest-first", () => {
    expect(parseChangelog(sample)).toEqual([
      { version: "0.5.5", date: "2026-06-29", summary: "ci: gate PRs.", summaries: ["ci: gate PRs."] },
      { version: "0.5.4", date: "2026-06-29", summary: "fix: loop.", summaries: ["fix: loop."] },
    ]);
  });
  it("captures every paragraph of a bundled release", () => {
    const bundled = ["## v0.9.0 — 2026-06-30", "", "fix: plumbing.", "", "feat: metrics card.", "", "feat: access modes."].join("\n");
    const [e] = parseChangelog(bundled);
    expect(e.summaries).toEqual(["fix: plumbing.", "feat: metrics card.", "feat: access modes."]);
    expect(e.summary).toBe("fix: plumbing."); // first paragraph, for single-line callers
  });
  it("collapses a multi-line paragraph into one summary", () => {
    const wrapped = ["## v1.0.0 — 2026-07-01", "", "a long line", "wrapped across rows."].join("\n");
    expect(parseChangelog(wrapped)[0].summaries).toEqual(["a long line wrapped across rows."]);
  });
  it("caps at the recent limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => `## v0.${i}.0 — 2026-01-01\n\nentry ${i}.`).join("\n\n");
    expect(parseChangelog(many, 10)).toHaveLength(10);
  });
  it("returns nothing for an empty changelog", () => {
    expect(parseChangelog("")).toEqual([]);
  });
});
