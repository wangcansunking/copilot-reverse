// Fuzzy model matching (agent-maestro v2.6.0): clients send ids like `claude-opus-4-8` or
// `claude-opus-4-8-20251101`, but Copilot advertises `claude-opus-4.8`. Map the request to the
// closest available model by Jaccard similarity over normalized tokens, so a near-miss id doesn't
// pass straight through and 404. Date stamps (6+ digit runs) are dropped before comparing.
function tokenize(id: string): Set<string> {
  return new Set(
    id.toLowerCase()
      .replace(/\b\d{6,}\b/g, " ")   // strip date/version stamps like 20251101
      .replace(/[-_.]+/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function bestModelMatch(requested: string, available: string[], threshold = 0.6): string | null {
  if (available.includes(requested)) return requested;
  const rt = tokenize(requested);
  let best: string | null = null;
  let bestScore = 0;
  for (const m of available) {
    const s = jaccard(rt, tokenize(m));
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return bestScore >= threshold ? best : null;
}
