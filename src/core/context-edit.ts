import type { CanonicalMessage, ToolResultBlock } from "./canonical.js";
import { MAX_IMAGE_BYTES } from "./image-resize.js";

// Context editing for images — our stand-in for Anthropic's server-side `clear_tool_uses_20250919`.
//
// Why this exists: the real Anthropic backend runs "context editing" (public beta, 2025-09) BEFORE the
// prompt reaches the model — as an agentic conversation grows, it clears the OLDEST tool results,
// replacing each with a placeholder, and keeps only the most recent few. Claude Code relies on this: it
// keeps sending the FULL, unmodified history every turn (the wire is stateless) and trusts the backend
// to trim. Copilot's backend has NO such layer, so a browser-harness loop — one screenshot per step,
// every screenshot re-sent every turn — accretes base64 until the request body trips Copilot's HTTP
// entity-size limit and comes back 413 ("Request Entity Too Large"), which we relay as a 502.
//
// We sit exactly where that backend layer would, so we do its job: keep the most recent `keep`
// screenshots at full fidelity and replace older ones with a short placeholder. This is distinct from
// image-resize.ts — that shrinks each image to fit the *token* budget (per-image), this bounds the
// *cumulative byte* payload across a long multi-turn conversation. Both run before send; resize first
// (so kept images are already small), then this clears the older ones that resize alone can't save.

// How many recent tool screenshots to always preserve at full fidelity — matches Anthropic's
// `clear_tool_uses` `keep` default of 3. Two or three recent screenshots are what an agent actually
// reasons over; older ones are almost always spent context.
export const KEEP_RECENT_SCREENSHOTS = 3;

// Cumulative byte budget for all tool-screenshot payloads in a single request. resize caps each image
// at MAX_IMAGE_BYTES (~1.5MB), so `keep` recent images sit safely under this; clearing only kicks in
// once ACCUMULATED history pushes past it. Set to 4× the per-image cap (~6MB) — headroom for the kept
// images plus conversation text, well below Copilot's gateway entity limit.
export const IMAGE_PAYLOAD_BUDGET = 4 * MAX_IMAGE_BYTES;

// Appended to a tool_result's text when its image(s) are cleared, so the model still knows a screenshot
// was there (mirrors Anthropic replacing cleared content with placeholder text). Also the idempotency
// marker: a result already bearing this is never counted or re-cleared.
export const CLEARED_SCREENSHOT_PLACEHOLDER = "[earlier screenshot removed to fit context]";

function byteLen(images: string[]): number {
  let n = 0;
  for (const img of images) n += img.length;
  return n;
}

// Every tool_result across the message list that still carries image(s), in conversation order
// (oldest first). Top-level image blocks are intentionally excluded — Anthropic's clear_tool_uses only
// touches tool RESULTS; a user-attached image is deliberate context and is the resize layer's concern.
function screenshotResults(messages: CanonicalMessage[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.images && b.images.length > 0) out.push(b);
    }
  }
  return out;
}

export interface ContextEditResult {
  clearedCount: number; // number of tool_result blocks whose images were cleared
  clearedBytes: number; // total base64 bytes freed
}

// Clear old tool screenshots in place so the cumulative image payload fits IMAGE_PAYLOAD_BUDGET, always
// preserving the most recent `keep`. Oldest-first, and stops the moment we're back under budget — the
// minimal edit, so we never drop context we didn't have to. Lossless (no-op) when already under budget.
export function editImageContextInPlace(
  messages: CanonicalMessage[],
  keep: number = KEEP_RECENT_SCREENSHOTS,
  budget: number = IMAGE_PAYLOAD_BUDGET,
): ContextEditResult {
  const results = screenshotResults(messages);
  let total = 0;
  for (const r of results) total += byteLen(r.images!);
  if (total <= budget) return { clearedCount: 0, clearedBytes: 0 };

  // Candidates to clear: everything except the most recent `keep`. Clear oldest-first, stopping as soon
  // as the running total is back within budget.
  const clearable = results.slice(0, Math.max(0, results.length - keep));
  let clearedCount = 0;
  let clearedBytes = 0;
  for (const r of clearable) {
    if (total <= budget) break;
    const freed = byteLen(r.images!);
    total -= freed;
    clearedBytes += freed;
    clearedCount++;
    // Replace the image(s) with a placeholder appended to the result text, then drop the images.
    r.content = r.content ? `${r.content}\n${CLEARED_SCREENSHOT_PLACEHOLDER}` : CLEARED_SCREENSHOT_PLACEHOLDER;
    delete r.images;
  }
  return { clearedCount, clearedBytes };
}
