import type { ChangeEntry } from "../changes.js";

// Pick the single "main" change to represent a release in the banner. A release can bundle several
// changesets (e.g. a headline feature + a plumbing fix + a small tweak); we must not just take the
// first paragraph, because the first is often the least interesting fix while the real headline is a
// `feat` further down — exactly what made v0.9.0 show "fix(release)…" instead of the access-modes
// feature. So rank by conventional-commit type (new capability > prose > fix/chore), breaking ties
// by length (the more substantial write-up wins). Exported for tests.
export function pickHeadline(summaries: string[]): string | undefined {
  if (!summaries.length) return undefined;
  // Higher = more headline-worthy. An untyped prose summary (no `type:` prefix) is treated as a
  // feature-grade write-up (older entries are hand-written prose), ranking above fixes/chores.
  const rank = (s: string): number => {
    const m = s.match(/^(\w+)(?:\([^)]*\))?:/);
    const type = m?.[1]?.toLowerCase();
    if (!type) return 3;                                  // untyped prose → feature-grade
    if (type === "feat" || type === "perf") return 4;     // new capability
    if (type === "fix") return 1;
    if (type === "chore" || type === "ci" || type === "docs" || type === "build" || type === "test" || type === "refactor" || type === "style") return 0;
    return 2;                                             // unknown type → above fix, below feat
  };
  return [...summaries].sort((a, b) => rank(b) - rank(a) || b.length - a.length)[0];
}

// Build the "what's new" banner body shown on startup: ONE line per recent release (newest first),
// each showing that version's main change, then a pointer to the full list. Per-version (not flatten-
// across-versions) so the newest release can't hog every slot — the user sees what changed across the
// last few versions at a glance. Pure, for testability.
export function buildChangeBannerLines(changes: ChangeEntry[], max = 3): string[] {
  const clip = (s: string) => (s.length > 86 ? s.slice(0, 85) + "…" : s);
  const lines: string[] = [];
  for (const c of changes) {
    if (lines.length >= max) break;
    const headline = pickHeadline(c.summaries);
    if (headline) lines.push(`• v${c.version} — ${clip(headline)}`);
  }
  if (!lines.length) return [];
  lines.push("• type /changes for the full list");
  return lines;
}
