import { describe, it, expect } from "vitest";

// Mirrors the parser in scripts/gen-changes.mjs (kept simple; the script is the source of truth).
// Guards the contract: each "## vX.Y.Z — DATE" + summary becomes one entry, newest-first, capped.
function parseChangelog(text: string, recent = 10) {
  const entries: { version: string; date: string; summary: string }[] = [];
  const re = /^## v(\d+\.\d+\.\d+) — (\S+)\n+([^\n]+)/gm;
  for (let m = re.exec(text); m && entries.length < recent; m = re.exec(text)) {
    entries.push({ version: m[1], date: m[2], summary: m[3].trim() });
  }
  return entries;
}

describe("changelog parser (gen-changes)", () => {
  const sample = ["## v0.5.5 — 2026-06-29", "", "ci: gate PRs.", "", "## v0.5.4 — 2026-06-29", "", "fix: loop.", ""].join("\n");
  it("captures version, date, summary newest-first", () => {
    expect(parseChangelog(sample)).toEqual([
      { version: "0.5.5", date: "2026-06-29", summary: "ci: gate PRs." },
      { version: "0.5.4", date: "2026-06-29", summary: "fix: loop." },
    ]);
  });
  it("caps at the recent limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => `## v0.${i}.0 — 2026-01-01\n\nentry ${i}.`).join("\n\n");
    expect(parseChangelog(many, 10)).toHaveLength(10);
  });
  it("returns nothing for an empty changelog", () => {
    expect(parseChangelog("")).toEqual([]);
  });
});
