// Whimsical loading verbs, à la Claude Code — rotated every ~3s based on elapsed time so the
// label changes as you wait. Deterministic per time-bucket (no per-render flicker).
export const LOADING_VERBS = [
  "Orchestrating", "Cogitating", "Pondering", "Noodling", "Conjuring", "Percolating",
  "Ruminating", "Synthesizing", "Marshalling", "Untangling", "Wrangling", "Spelunking",
];
export function loadingVerb(elapsedMs: number): string {
  return LOADING_VERBS[Math.floor(Math.max(0, elapsedMs) / 3000) % LOADING_VERBS.length];
}

// Human-readable context window, e.g. 1_000_000 -> "1M", 200_000 -> "200K". Empty when unknown.
export function formatContextWindow(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// Bulleted model list with context windows — used by the assistant's list_models tool.
export function formatModelList(ids: string[], limits?: Record<string, number>): string {
  if (!ids.length) return "(no models found)";
  return ids.map((id) => {
    const w = formatContextWindow(limits?.[id]);
    return `- ${id}${w ? ` (${w})` : ""}`;
  }).join("\n");
}

// Flatten an arbitrary string to a single contained line for display in a bordered TUI card.
// Upstream errors can be whole HTML pages (a Copilot 502 returns one) whose embedded newlines,
// rendered inside one Ink <Text>, shatter the card border. Collapse every whitespace run — newlines,
// CRs, tabs included — to a single space, trim, then truncate with an ellipsis so one nasty error
// can't blow up the layout. `max` counts the ellipsis (output length is always <= max).
export function oneLine(s: string | undefined, max = 200): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

