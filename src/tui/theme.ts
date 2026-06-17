// Claude-Code-inspired palette. Warm coral accent, muted secondary text, clear state colors.
// Named colors keep broad terminal compatibility; the accent uses hex (truecolor terminals).
export const theme = {
  accent: "#cc785c", // Claude clay/coral
  prompt: "#cc785c",
  user: "white",
  assistant: "white",
  output: "gray",
  muted: "gray",
  border: "gray",
  ready: "green",
  starting: "yellow",
  crashed: "redBright",
  unhealthy: "red",
  error: "red",
} as const;
