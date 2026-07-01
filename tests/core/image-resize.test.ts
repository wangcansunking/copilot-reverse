import { describe, it, expect } from "vitest";
import { Jimp, JimpMime } from "jimp";
import { randomFillSync } from "node:crypto";
import { shrinkDataUrl, shrinkImagesInPlace, MAX_IMAGE_EDGE } from "../../src/core/image-resize.js";
import type { CanonicalMessage } from "../../src/core/canonical.js";

// Build a real PNG data URL of the given dimensions (solid color, so it encodes tiny — we pad the
// byte-budget tests separately). A real encoder output keeps these tests honest about the decode path.
async function pngDataUrl(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0x3366ccff });
  const buf = await img.getBuffer(JimpMime.png);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// A high-entropy (random-pixel) PNG: it can't run-length compress, so its base64 is large and
// realistic — the case that actually blows the token budget (a detailed screenshot), unlike a solid
// color that encodes to a few KB.
async function noisePngDataUrl(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0 });
  randomFillSync(img.bitmap.data);
  const buf = await img.getBuffer(JimpMime.png);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function edgeOf(dataUrl: string): Promise<{ w: number; h: number }> {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Jimp.fromBuffer(Buffer.from(b64, "base64")).then((img) => ({ w: img.width, h: img.height }));
}

describe("shrinkDataUrl", () => {
  it("downscales an image whose long edge exceeds the cap", async () => {
    const big = await pngDataUrl(4000, 2000);
    const out = await shrinkDataUrl(big);
    const { w, h } = await edgeOf(out);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    // Aspect ratio preserved (2:1 within rounding).
    expect(w / h).toBeCloseTo(2, 1);
  });

  it("leaves a small image's pixels alone (long edge already under the cap)", async () => {
    const small = await pngDataUrl(100, 80);
    const out = await shrinkDataUrl(small);
    const { w, h } = await edgeOf(out);
    expect(w).toBe(100);
    expect(h).toBe(80);
  });

  // The whole point: a realistic oversized image's byte payload must collapse. A noise PNG at 2.3M+
  // base64 chars (≈ the size behind the real 502) must shrink dramatically AND re-encode to JPEG.
  it("collapses the byte payload of a large high-entropy image", async () => {
    const big = await noisePngDataUrl(1800, 1200);
    const out = await shrinkDataUrl(big);
    expect(out.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out.length).toBeLessThan(big.length / 2); // at least halved; in practice ~6x smaller
  });

  it("returns the input unchanged when it isn't a base64 image data URL", async () => {
    const url = "https://example.com/cat.png";
    expect(await shrinkDataUrl(url)).toBe(url);
  });

  it("returns the input unchanged when the payload can't be decoded", async () => {
    const garbage = "data:image/png;base64,not-real-image-bytes";
    expect(await shrinkDataUrl(garbage)).toBe(garbage);
  });
});

describe("shrinkImagesInPlace", () => {
  it("rewrites oversized image blocks across messages and leaves text untouched", async () => {
    const big = await pngDataUrl(3000, 3000);
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", dataUrl: big }] },
    ];
    await shrinkImagesInPlace(messages);
    const img = messages[0].content.find((b) => b.type === "image") as { dataUrl: string };
    const { w, h } = await edgeOf(img.dataUrl);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(messages[0].content[0]).toEqual({ type: "text", text: "look" });
  });

  it("is a no-op for messages with no images", async () => {
    const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const before = JSON.stringify(messages);
    await shrinkImagesInPlace(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
