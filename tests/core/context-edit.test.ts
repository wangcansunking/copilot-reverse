import { describe, it, expect } from "vitest";
import {
  editImageContextInPlace,
  forceClearAllScreenshots,
  is413Error,
  KEEP_RECENT_SCREENSHOTS,
  IMAGE_PAYLOAD_BUDGET,
  CLEARED_SCREENSHOT_PLACEHOLDER,
} from "../../src/core/context-edit.js";
import type { CanonicalMessage } from "../../src/core/canonical.js";

// A base64 image data URL of a given byte length (content is irrelevant here — context editing works on
// the payload SIZE, never decodes). Pad to `bytes` so we can drive the byte-budget trigger precisely.
function imageOfBytes(bytes: number): string {
  const prefix = "data:image/jpeg;base64,";
  return prefix + "A".repeat(Math.max(0, bytes - prefix.length));
}

// One `tool` message carrying a single tool_result screenshot — the shape a browser-harness turn
// produces (a tool that returns an image). `n` just makes the toolUseId unique/inspectable.
function screenshotTurn(n: number, image: string): CanonicalMessage {
  return { role: "tool", content: [{ type: "tool_result", toolUseId: `shot-${n}`, content: `screenshot ${n}`, images: [image] }] };
}

function imagesOf(msg: CanonicalMessage): string[] {
  const tr = msg.content.find((b) => b.type === "tool_result") as { images?: string[] } | undefined;
  return tr?.images ?? [];
}
function textOf(msg: CanonicalMessage): string {
  const tr = msg.content.find((b) => b.type === "tool_result") as { content: string } | undefined;
  return tr?.content ?? "";
}

describe("editImageContextInPlace", () => {
  it("is a no-op when total image bytes are within budget", () => {
    // Three small screenshots, comfortably under budget — nothing should be touched.
    const small = imageOfBytes(1000);
    const messages: CanonicalMessage[] = [screenshotTurn(1, small), screenshotTurn(2, small), screenshotTurn(3, small)];
    const before = JSON.stringify(messages);
    const res = editImageContextInPlace(messages);
    expect(res.clearedCount).toBe(0);
    expect(JSON.stringify(messages)).toBe(before); // byte-identical, lossless
  });

  it("breaks the keep-floor when the most recent `keep` alone exceed budget (must beat a 413)", () => {
    // keep=3 screenshots, EACH already over budget on its own → the kept set can't fit no matter what.
    // The floor is a preference, not a hard limit: clearing must break through it, oldest-first, until
    // the payload is under budget — otherwise the body still 413s, which is strictly worse.
    const big = imageOfBytes(IMAGE_PAYLOAD_BUDGET); // one image alone exceeds the budget
    const messages: CanonicalMessage[] = Array.from({ length: KEEP_RECENT_SCREENSHOTS }, (_, i) => screenshotTurn(i, big));
    const res = editImageContextInPlace(messages);
    expect(res.clearedCount).toBeGreaterThan(0);
    // Cleared oldest-first: the newest is the last one standing (or the only one left under budget).
    expect(imagesOf(messages[0])).toHaveLength(0);
    // The remaining image payload is within budget.
    let remaining = 0;
    for (const m of messages) for (const url of imagesOf(m)) remaining += url.length;
    expect(remaining).toBeLessThanOrEqual(IMAGE_PAYLOAD_BUDGET);
  });

  it("keeps the budget below the probed 5 MiB gateway limit (with headroom for non-image content)", () => {
    // The gateway rejects a ≥5 MiB (5,242,880-byte) request body with 413. The image budget must sit
    // well under that so the rest of the request (text, tools, structure) still fits. Regression guard
    // against the original 6MB budget that was ABOVE the wall and let over-limit bodies through.
    const GATEWAY_LIMIT = 5 * 1024 * 1024;
    expect(IMAGE_PAYLOAD_BUDGET).toBeLessThan(GATEWAY_LIMIT);
    expect(GATEWAY_LIMIT - IMAGE_PAYLOAD_BUDGET).toBeGreaterThanOrEqual(1_000_000); // ≥1MB headroom
  });

  it("clears the OLDEST screenshots first, preserving the most recent `keep`", () => {
    // Six screenshots each ~ a quarter of the budget → total ~1.5x budget, and the recent `keep` (3)
    // together are ~0.75x budget (they fit). Editing must clear oldest-first until under budget, which
    // is achievable WITHOUT touching the most recent `keep`.
    const quarter = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET / 4));
    const messages: CanonicalMessage[] = Array.from({ length: 6 }, (_, i) => screenshotTurn(i, quarter));
    const res = editImageContextInPlace(messages);

    expect(res.clearedCount).toBeGreaterThan(0);
    // The most recent `keep` still carry their image.
    for (let i = 6 - KEEP_RECENT_SCREENSHOTS; i < 6; i++) expect(imagesOf(messages[i])).toHaveLength(1);
    // The oldest were cleared: image gone, placeholder appended to the text so the model knows.
    expect(imagesOf(messages[0])).toHaveLength(0);
    expect(textOf(messages[0])).toContain(CLEARED_SCREENSHOT_PLACEHOLDER);
    expect(textOf(messages[0])).toContain("screenshot 0"); // original text retained
  });

  it("stops clearing as soon as the payload is back under budget (minimal edit)", () => {
    // Recent 3 are tiny; two older heavy ones push total over budget. Clearing ONE oldest heavy image
    // should be enough — the second heavy image should be spared once we're under budget again.
    const tiny = imageOfBytes(1000);
    const heavy = imageOfBytes(IMAGE_PAYLOAD_BUDGET); // each alone > budget
    const messages: CanonicalMessage[] = [
      screenshotTurn(0, heavy), // oldest — expected cleared
      screenshotTurn(1, heavy), // second — still over budget after clearing #0, so also cleared
      screenshotTurn(2, tiny),
      screenshotTurn(3, tiny),
      screenshotTurn(4, tiny),
    ];
    editImageContextInPlace(messages);
    // Both heavy ones exceed budget individually, so both must go; the tiny recent ones stay.
    expect(imagesOf(messages[0])).toHaveLength(0);
    expect(imagesOf(messages[1])).toHaveLength(0);
    for (let i = 2; i < 5; i++) expect(imagesOf(messages[i])).toHaveLength(1);
  });

  it("clears a multi-image tool_result as a unit and reports bytes freed", () => {
    const heavy = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET * 0.8));
    const messages: CanonicalMessage[] = [
      { role: "tool", content: [{ type: "tool_result", toolUseId: "multi", content: "grid", images: [heavy, heavy] }] },
      screenshotTurn(1, imageOfBytes(1000)),
      screenshotTurn(2, imageOfBytes(1000)),
      screenshotTurn(3, imageOfBytes(1000)),
    ];
    const res = editImageContextInPlace(messages);
    expect(imagesOf(messages[0])).toHaveLength(0);              // both images in the block cleared together
    expect(res.clearedBytes).toBeGreaterThanOrEqual(heavy.length * 2);
    expect(textOf(messages[0])).toContain(CLEARED_SCREENSHOT_PLACEHOLDER);
  });

  it("leaves top-level (non-tool_result) images untouched — only tool screenshots are cleared", () => {
    // A user-attached image is intentional context, not an agentic tool artifact; Anthropic's
    // clear_tool_uses only clears tool RESULTS, never a top-level image. Six over-budget tool screenshots
    // force clearing; the top-level image must survive it untouched. (A top-level image large enough to
    // blow the wall on its own is the resize layer's job, upstream of here.)
    const topLevel = imageOfBytes(200_000); // a normal user-attached image, well under any per-image cap
    const heavy = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET / 2));
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", dataUrl: topLevel }] },
      ...Array.from({ length: 6 }, (_, i) => screenshotTurn(i, heavy)),
    ];
    const res = editImageContextInPlace(messages);
    expect(res.clearedCount).toBeGreaterThan(0); // tool screenshots were cleared
    const img = messages[0].content.find((b) => b.type === "image") as { dataUrl: string };
    expect(img.dataUrl).toBe(topLevel); // the TOP-LEVEL image is untouched
  });

  it("does not append a second placeholder if run twice (idempotent on cleared results)", () => {
    const half = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET / 2));
    const messages: CanonicalMessage[] = Array.from({ length: 6 }, (_, i) => screenshotTurn(i, half));
    editImageContextInPlace(messages);
    const afterFirst = messages.map(textOf);
    editImageContextInPlace(messages);
    expect(messages.map(textOf)).toEqual(afterFirst); // second pass changes nothing new
  });

  // A tool_result carrying a large TEXT body plus a screenshot — used to drive the non-image byte total
  // way up (a huge pasted transcript, a 700k-token conversation) so the dynamic budget has to shrink the
  // image allowance. `textBytes` pads the tool_result's own text.
  function screenshotTurnWithText(n: number, image: string, textBytes: number): CanonicalMessage {
    return { role: "tool", content: [{ type: "tool_result", toolUseId: `shot-${n}`, content: "x".repeat(textBytes), images: [image] }] };
  }

  it("shrinks the image allowance when non-image text is huge, so the WHOLE body fits the 5 MiB wall", () => {
    // The issue-52 follow-up: even after keeping only 3 screenshots (~3.15MB), a 700k-token conversation
    // (~2.67MB of text) pushes the TOTAL body over the 5 MiB gateway wall → still 413. A fixed 3.5MB
    // image budget can't see the text. The dynamic budget must: with ~2.9MB of non-image text present,
    // the image allowance has to drop well below 3.5MB so images+text land under the wall.
    const GATEWAY_LIMIT = 5 * 1024 * 1024;
    const bigText = 2_900_000; // ~700k tokens of conversation, carried as tool_result text
    const img = imageOfBytes(1_100_000); // ~1.1MB each (issue-52-sized, under the per-image resize cap)
    const messages: CanonicalMessage[] = [
      screenshotTurnWithText(0, img, bigText), // the text lives on the oldest turn; its image may clear but text stays
      screenshotTurn(1, img),
      screenshotTurn(2, img),
      screenshotTurn(3, img),
      screenshotTurn(4, img),
    ];
    editImageContextInPlace(messages);
    // Sum EVERYTHING that goes on the wire: remaining images + all tool_result text.
    let imageBytes = 0, textBytes = 0;
    for (const m of messages) for (const b of m.content) {
      if (b.type === "tool_result") { textBytes += b.content.length; for (const u of b.images ?? []) imageBytes += u.length; }
    }
    const total = imageBytes + textBytes;
    expect(total).toBeLessThan(GATEWAY_LIMIT); // the whole body — not just images — is under the wall
  });

  it("still uses the full fixed budget when there is little non-image text (no needless clearing)", () => {
    // Backward-compat: with negligible text, the effective budget is the fixed IMAGE_PAYLOAD_BUDGET, so a
    // payload that fits it is untouched — the dynamic path must not over-clear the common case.
    const img = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET / 3)); // 3 images ≈ full budget, tiny text
    const messages: CanonicalMessage[] = [screenshotTurn(0, img), screenshotTurn(1, img), screenshotTurn(2, img)];
    const res = editImageContextInPlace(messages);
    expect(res.clearedCount).toBe(0); // fits the fixed budget, nothing cleared
  });
});

describe("reactive 413 fallback helpers", () => {
  it("is413Error detects the adapter's 413 phrasings", () => {
    expect(is413Error(new Error("copilot completion failed: 413 — Request Entity Too Large"))).toBe(true);
    expect(is413Error(new Error("copilot stream failed: 413"))).toBe(true);
    expect(is413Error("request entity too large")).toBe(true);
    expect(is413Error(new Error("copilot completion failed: 400 — bad model"))).toBe(false);
    expect(is413Error(new Error("some other error"))).toBe(false);
  });

  it("forceClearAllScreenshots strips EVERY tool screenshot (keep=0, budget=0)", () => {
    const img = imageOfBytes(500_000);
    const messages: CanonicalMessage[] = [
      { role: "tool", content: [{ type: "tool_result", toolUseId: "a", content: "one", images: [img] }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "b", content: "two", images: [img] }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c", content: "three", images: [img] }] },
    ];
    const res = forceClearAllScreenshots(messages);
    expect(res.clearedCount).toBe(3); // even the most recent — the floor doesn't apply, budget is 0
    for (const m of messages) {
      const tr = m.content.find((b) => b.type === "tool_result") as { images?: string[]; content: string };
      expect(tr.images ?? []).toHaveLength(0);
      expect(tr.content).toContain(CLEARED_SCREENSHOT_PLACEHOLDER);
    }
  });

  it("forceClearAllScreenshots is idempotent (a second call clears nothing more)", () => {
    const messages: CanonicalMessage[] = [
      { role: "tool", content: [{ type: "tool_result", toolUseId: "a", content: "one", images: [imageOfBytes(500_000)] }] },
    ];
    forceClearAllScreenshots(messages);
    const second = forceClearAllScreenshots(messages);
    expect(second.clearedCount).toBe(0);
  });
});
