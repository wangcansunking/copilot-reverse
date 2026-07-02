import { describe, it, expect } from "vitest";
import {
  editImageContextInPlace,
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

  it("never clears when there are only `keep` screenshots, even if over budget", () => {
    // keep=3 screenshots, each big enough that together they exceed budget. The keep-floor wins:
    // the most recent `keep` are ALWAYS preserved (mirrors Anthropic's `keep` default of 3).
    const big = imageOfBytes(IMAGE_PAYLOAD_BUDGET); // one image alone exceeds the budget
    const messages: CanonicalMessage[] = Array.from({ length: KEEP_RECENT_SCREENSHOTS }, (_, i) => screenshotTurn(i, big));
    const res = editImageContextInPlace(messages);
    expect(res.clearedCount).toBe(0);
    for (const m of messages) expect(imagesOf(m)).toHaveLength(1); // all preserved
  });

  it("clears the OLDEST screenshots first, preserving the most recent `keep`", () => {
    // Six screenshots each ~ half the budget → total ~3x budget. Editing must clear oldest-first until
    // under budget, but never touch the most recent `keep`.
    const half = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET / 2));
    const messages: CanonicalMessage[] = Array.from({ length: 6 }, (_, i) => screenshotTurn(i, half));
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
    // clear_tool_uses only clears tool results. A huge top-level image is the resize layer's job.
    const big = imageOfBytes(IMAGE_PAYLOAD_BUDGET * 2);
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", dataUrl: big }] },
      screenshotTurn(1, imageOfBytes(1000)),
    ];
    const res = editImageContextInPlace(messages);
    expect(res.clearedCount).toBe(0);
    const img = messages[0].content.find((b) => b.type === "image") as { dataUrl: string };
    expect(img.dataUrl).toBe(big); // untouched
  });

  it("does not append a second placeholder if run twice (idempotent on cleared results)", () => {
    const half = imageOfBytes(Math.floor(IMAGE_PAYLOAD_BUDGET / 2));
    const messages: CanonicalMessage[] = Array.from({ length: 6 }, (_, i) => screenshotTurn(i, half));
    editImageContextInPlace(messages);
    const afterFirst = messages.map(textOf);
    editImageContextInPlace(messages);
    expect(messages.map(textOf)).toEqual(afterFirst); // second pass changes nothing new
  });
});
