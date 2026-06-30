import type { ReasoningConfig, ReasoningEffort } from "./canonical.js";

// The effort enum Copilot accepts on /chat + /responses (and that Anthropic-protocol clients pick from).
// "none" disables reasoning; the rest scale depth. Unknown strings normalize to "medium" so a client
// sending a slightly-off label still gets reasoning rather than silently none.
const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

export function normalizeEffort(effort: string | undefined | null): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  if ((EFFORTS as string[]).includes(e)) return e as ReasoningEffort;
  if (e === "minimal") return "low";   // gemini uses "minimal"
  return "medium";
}

// OpenAI `reasoning_effort` (a bare enum) -> canonical reasoning config.
export function reasoningFromEffort(effort: string | undefined | null): ReasoningConfig | undefined {
  const e = normalizeEffort(effort);
  return e ? { effort: e } : undefined;
}

// Anthropic `thinking: { type: "enabled", budget_tokens }` -> canonical reasoning. Anthropic gates
// reasoning with a TOKEN BUDGET, not an enum, so map the budget onto the nearest effort bucket. The
// buckets mirror Copilot's advertised min/max thinking budget (~1k..32k) so a client's budget lands
// on a sensible effort. type:"disabled" (or absent) yields no reasoning.
export function reasoningFromThinking(thinking: { type?: string; budget_tokens?: number } | undefined): ReasoningConfig | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  const budget = thinking.budget_tokens;
  if (budget == null) return { effort: "medium" }; // enabled with no explicit budget
  if (budget <= 2048) return { effort: "low" };
  if (budget <= 8192) return { effort: "medium" };
  if (budget <= 20000) return { effort: "high" };
  return { effort: "max" };
}
