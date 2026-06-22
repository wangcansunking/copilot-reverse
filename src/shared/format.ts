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
