// Human-readable context window, e.g. 1_000_000 -> "1M", 200_000 -> "200K". Empty when unknown.
export function formatContextWindow(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
