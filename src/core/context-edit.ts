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

// Cumulative byte budget for all tool-screenshot payloads in a single request — a CEILING on the image
// allowance. The true constraint is the whole request body (images + text + tool JSON), so the
// EFFECTIVE budget is computed dynamically per request (see below) and this value only caps it from
// above for the common case where non-image content is small. That case still wants headroom under the
// gateway wall, so 3.5MB.
//
// (An earlier value of 4× the per-image cap ≈ 6MB was ABOVE the real 5 MiB gateway limit, so context
// editing believed an over-limit payload was "within budget" and forwarded it straight into a 413.)
export const IMAGE_PAYLOAD_BUDGET = 3_500_000;

// Copilot's gateway HTTP entity limit, PROBED at exactly 5 MiB (5,242,880 bytes): a ~4.95MB body returns
// 400 (accepted, model-name-only error) while a 5.00MB body returns 413. The WHOLE request body must fit
// under this — not just images.
export const GATEWAY_ENTITY_LIMIT = 5 * 1024 * 1024;

// Headroom reserved under the gateway limit for content we DON'T byte-count exactly: JSON structural
// overhead (quoting/escaping/field names), the model's own reply allowance, and rounding in our char-
// based text sizing. The dynamic image budget is GATEWAY_ENTITY_LIMIT − SAFETY_MARGIN − nonImageBytes.
export const SAFETY_MARGIN = 512 * 1024;

// Appended to a tool_result's text when its image(s) are cleared, so the model still knows a screenshot
// was there (mirrors Anthropic replacing cleared content with placeholder text). Also the idempotency
// marker: a result already bearing this is never counted or re-cleared.
export const CLEARED_SCREENSHOT_PLACEHOLDER = "[earlier screenshot removed to fit context]";

function byteLen(images: string[]): number {
  let n = 0;
  for (const img of images) n += img.length;
  return n;
}

// Every byte on the wire that ISN'T a tool screenshot: message/tool text, tool_use inputs, tool_result
// text, and top-level (user-attached) images — which context editing never clears, so they count as
// fixed overhead. This is what the dynamic image budget must subtract from the gateway limit: a big
// conversation (a 700k-token transcript ≈ 2.7MB of text) leaves far less room for images, and a fixed
// image-only budget can't see it. Mirrors estimateTokens's traversal but sums BYTES, not tokens.
function nonImageBytes(messages: CanonicalMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.role.length;
    for (const b of m.content) {
      if (b.type === "text") n += b.text.length;
      else if (b.type === "image") n += b.dataUrl.length; // top-level image: fixed, never cleared here
      else if (b.type === "tool_use") n += b.name.length + JSON.stringify(b.input ?? {}).length;
      else if (b.type === "tool_result") n += b.content.length; // the tool_result's IMAGES are excluded — they're the clearable payload
    }
  }
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

// Clear old tool screenshots in place so the WHOLE request body fits under Copilot's gateway entity
// limit, preferring to preserve the most recent `keep`. The image allowance is DYNAMIC: it's the gateway
// limit minus a safety margin minus the non-image bytes actually present (conversation text, tool JSON,
// top-level images), capped by IMAGE_PAYLOAD_BUDGET for the common small-text case. So a huge transcript
// automatically shrinks how many screenshots we may keep — the fix for the issue-52 follow-up where 3
// kept screenshots (~3.15MB) plus a 700k-token conversation (~2.7MB) still blew past the 5 MiB wall.
//
// Oldest-first, stopping the moment we're under the effective budget. If clearing everything OLDER than
// the most recent `keep` still isn't enough, the keep-floor is broken: keep clearing oldest-first through
// the recent ones too (up to and including the newest), because a body that still 413s is worse than one
// that lost a recent screenshot.
export function editImageContextInPlace(
  messages: CanonicalMessage[],
  keep: number = KEEP_RECENT_SCREENSHOTS,
  budget: number = IMAGE_PAYLOAD_BUDGET,
): ContextEditResult {
  const results = screenshotResults(messages);
  let total = 0;
  for (const r of results) total += byteLen(r.images!);

  // Effective image allowance: whichever is SMALLER of the fixed ceiling and what the gateway actually
  // leaves for images once the non-image body is accounted for. Never below 0 (a conversation whose text
  // alone exceeds the limit gets an allowance of 0 → clear every screenshot; the remaining overflow is
  // then out of our hands and handled reactively on a real 413).
  const roomForImages = GATEWAY_ENTITY_LIMIT - SAFETY_MARGIN - nonImageBytes(messages);
  const effectiveBudget = Math.max(0, Math.min(budget, roomForImages));
  if (total <= effectiveBudget) return { clearedCount: 0, clearedBytes: 0 };

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
  // the instant we're back under the effective budget. This spares the recent `keep` whenever the older
  // ones free enough (the common case).
  const boundary = Math.max(0, results.length - keep);
  for (let i = 0; i < boundary && total > effectiveBudget; i++) clear(results[i]);

  // Phase 2 — floor break: if clearing every older screenshot still left us over budget, the most recent
  // `keep` alone exceed the allowance. Keep clearing oldest-first THROUGH the recent ones (up to and
  // including the newest) — a body that still 413s is strictly worse than one missing a recent shot.
  for (let i = boundary; i < results.length && total > effectiveBudget; i++) clear(results[i]);

  return { clearedCount, clearedBytes };
}

// True if a thrown upstream error is a gateway 413 (request entity too large). The adapter surfaces it
// as `copilot completion failed: 413 …` / `copilot stream failed: 413 …`, so we match the status+phrase.
export function is413Error(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b413\b|request entity too large|entity too large/.test(m);
}

// Last-resort reactive fallback for an actual upstream 413: clear EVERY tool screenshot (keep=0,
// budget=0), so a retry sends the smallest possible body. Used only after the proactive dynamic budget
// somehow still produced a 413 (e.g. the gateway limit shifted, or non-image content we don't byte-count
// pushed it over). Returns what was freed; a caller retries once. Idempotent — a second call clears
// nothing more.
export function forceClearAllScreenshots(messages: CanonicalMessage[]): ContextEditResult {
  return editImageContextInPlace(messages, 0, 0);
}
