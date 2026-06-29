// Maps Copilot's model ids to the canonical ids Claude Code recognises, so its native /model picker
// lights up with friendly names, tier grouping, and the 1M-context badge instead of bare ids.
//
// Copilot advertises DOTTED ids (claude-opus-4.8); Claude Code's built-in table keys on DASHED ids
// (claude-opus-4-8) and shows the 1M badge only when the id ends with the [1m] suffix. So OUTBOUND
// (/v1/models, ANTHROPIC_MODEL) we dash every claude id + add [1m] for the families Claude Code knows
// to be 1M; INBOUND the proxy strips [1m] and fuzzy-maps the dashed id back to Copilot's dotted id
// (see bestModelMatch). Non-claude ids (gpt*, o3*) have no canonical form → pass through untouched.
export const ONE_M_SUFFIX = "[1m]";

// Dashed canonical ids whose Claude Code table carries a 1M window — only these get the [1m] badge.
// Everything else stays at its default window. Anchored on the probed v2.1.195 binary table.
const ONE_M_MODELS = new Set(["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"]);

// claude-<family>-<major>-<minor> -> "Family Major.Minor" (e.g. claude-opus-4-8 -> "Opus 4.8").
function displayName(dashed: string): string {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/.exec(dashed);
  if (!m) return dashed;
  const [, fam, maj, min] = m;
  return `${fam[0].toUpperCase()}${fam.slice(1)} ${maj}.${min}`;
}

export interface CanonicalModel { id: string; display_name: string }

// Outbound: Copilot id -> the id+display Claude Code's picker understands. Claude ids are dashed to the
// canonical form; the 1M families get the [1m] suffix so the picker shows the badge and sizes context
// to 1M. Non-claude ids echo back as-is so they still appear, just without native metadata.
export function toCanonical(copilotId: string): CanonicalModel {
  if (!copilotId.startsWith("claude-")) return { id: copilotId, display_name: copilotId };
  const dashed = copilotId.replace(/\./g, "-");
  const id = ONE_M_MODELS.has(dashed) ? `${dashed}${ONE_M_SUFFIX}` : dashed;
  return { id, display_name: displayName(dashed) };
}

// Inbound: drop the [1m] picker suffix. The dashed canonical id then resolves back to Copilot's
// dotted id via the router's exact map + fuzzy fallback; nothing else to do here.
export function stripOneM(model: string): string {
  return model.endsWith(ONE_M_SUFFIX) ? model.slice(0, -ONE_M_SUFFIX.length) : model;
}
