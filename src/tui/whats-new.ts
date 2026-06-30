import type { ChangeEntry } from "../changes.js";

// Build the "what's new" banner body shown on startup: the top few real headlines across recent
// releases (newest first), each tagged with its version, then a pointer to the full list. A bundled
// release carries several changes (summaries), so we flatten ACROSS releases rather than show one
// line per version — otherwise a headline feature shipped alongside a plumbing fix would never
// surface (the bug that made the banner look empty right after a big release). Pure, for testability.
export function buildChangeBannerLines(changes: ChangeEntry[], max = 3): string[] {
  const clip = (s: string) => (s.length > 86 ? s.slice(0, 85) + "…" : s);
  const lines: string[] = [];
  for (const c of changes) {
    for (const s of c.summaries) {
      if (lines.length >= max) break;
      lines.push(`• v${c.version} — ${clip(s)}`);
    }
    if (lines.length >= max) break;
  }
  if (!lines.length) return [];
  lines.push("• type /changes for the full list");
  return lines;
}
