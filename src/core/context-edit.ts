import type { CanonicalMessage, ToolResultBlock } from "./canonical.js";

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

// How many recent tool screenshots to preserve at full fidelity when possible — matches Anthropic's
// `clear_tool_uses` `keep` default of 3. Two or three recent screenshots are what an agent actually
// reasons over; older ones are almost always spent context. This is a PREFERENCE, not a hard floor: if
// even the most recent `keep` screenshots together exceed the budget, clearing breaks through the floor
// (oldest-first, up to and including the newest). A body that still 413s is strictly worse than one with
// fewer images, so fitting under the gateway limit always wins over keeping a recent screenshot.
export const KEEP_RECENT_SCREENSHOTS = 3;

// Cumulative byte budget for all tool-screenshot payloads in a single request — the number that keeps
// the whole request body under Copilot's gateway HTTP entity limit. That limit was PROBED at exactly
// 5 MiB (5,242,880 bytes): a ~4.95MB body returns 400 (accepted, model-name-only error) while a 5.00MB
// body returns 413. The budget sits well BELOW that hard wall to leave room for everything else in the
// request that isn't a tool screenshot — conversation text, tool schemas, top-level images, and JSON
// structural overhead. 3.5MB leaves ~1.5MB of headroom under the 5 MiB wall.
//
// (An earlier value of 4× the per-image cap ≈ 6MB was ABOVE the real 5 MiB gateway limit, so context
// editing believed an over-limit payload was "within budget" and forwarded it straight into a 413.)
export const IMAGE_PAYLOAD_BUDGET = 3_500_000;

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

// Clear old tool screenshots in place so the cumulative image payload fits IMAGE_PAYLOAD_BUDGET,
// preferring to preserve the most recent `keep`. Oldest-first, stopping the moment we're back under
// budget — the minimal edit, so we never drop context we didn't have to. Lossless (no-op) when already
// under budget. If clearing everything OLDER than the most recent `keep` still isn't enough, the
// keep-floor is broken: keep clearing oldest-first through the recent ones too (up to and including the
// newest), because a body that still 413s is worse than one that lost a recent screenshot.
export function editImageContextInPlace(
  messages: CanonicalMessage[],
  keep: number = KEEP_RECENT_SCREENSHOTS,
  budget: number = IMAGE_PAYLOAD_BUDGET,
): ContextEditResult {
  const results = screenshotResults(messages);
  let total = 0;
  for (const r of results) total += byteLen(r.images!);
  if (total <= budget) return { clearedCount: 0, clearedBytes: 0 };

  let clearedCount = 0;
  let clearedBytes = 0;
  const clear = (r: ToolResultBlock) => {
    const freed = byteLen(r.images!);
    total -= freed;
    clearedBytes += freed;
    clearedCount++;
    // Replace the image(s) with a placeholder appended to the result text, then drop the images.
    r.content = r.content ? `${r.content}\n${CLEARED_SCREENSHOT_PLACEHOLDER}` : CLEARED_SCREENSHOT_PLACEHOLDER;
    delete r.images;
  };

  // Phase 1 — preferred: clear only screenshots OLDER than the most recent `keep`, oldest-first, stopping
  // the instant we're back under budget. This spares the recent `keep` whenever the older ones free
  // enough (the common case).
  const boundary = Math.max(0, results.length - keep);
  for (let i = 0; i < boundary && total > budget; i++) clear(results[i]);

  // Phase 2 — floor break: if clearing every older screenshot still left us over budget, the most recent
  // `keep` alone exceed the gateway limit. Keep clearing oldest-first THROUGH the recent ones (up to and
  // including the newest) — a body that still 413s is strictly worse than one missing a recent shot.
  for (let i = boundary; i < results.length && total > budget; i++) clear(results[i]);

  return { clearedCount, clearedBytes };
}
