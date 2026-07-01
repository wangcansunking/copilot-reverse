import { describe, it, expect } from "vitest";
import { Jimp, JimpMime } from "jimp";
import { randomFillSync } from "node:crypto";
import { shrinkDataUrl, shrinkImagesInPlace, MAX_IMAGE_EDGE, MAX_IMAGE_BYTES } from "../../src/core/image-resize.js";
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
  it("downscales an over-budget image whose long edge exceeds the cap", async () => {
    const big = await noisePngDataUrl(4000, 2000); // over budget → decoded + downscaled
    const out = await shrinkDataUrl(big);
    const { w, h } = await edgeOf(out);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    // Aspect ratio preserved (2:1 within rounding).
    expect(w / h).toBeCloseTo(2, 1);
  });

  it("leaves a small image's pixels alone (well under the byte budget)", async () => {
    const small = await pngDataUrl(100, 80);
    const out = await shrinkDataUrl(small);
    expect(out).toBe(small); // byte-identical passthrough
  });

  // The whole point: a realistic oversized image's byte payload must collapse. A noise PNG at 2.3M+
  // base64 chars (≈ the size behind the real 502) must shrink dramatically AND re-encode to JPEG.
  it("collapses the byte payload of a large high-entropy image", async () => {
    const big = await noisePngDataUrl(1800, 1200);
    const out = await shrinkDataUrl(big);
    expect(out.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out.length).toBeLessThan(big.length / 2); // at least halved; in practice ~6x smaller
  });

  // The byte-gate gap: an image whose LONG EDGE is already within MAX_IMAGE_EDGE but whose BYTES are
  // huge (a high-detail photo, the exact "I read a normal-looking image and still got a 502" case). A
  // pixel-only gate would pass it through untouched. It MUST be re-encoded down under the byte budget.
  it("shrinks a within-edge image whose bytes exceed the budget (photo case)", async () => {
    // 1568x1400 noise: long edge == the cap, so a size gate wouldn't touch it, yet it's ~2.9M tokens.
    const heavy = await noisePngDataUrl(MAX_IMAGE_EDGE, 1400);
    expect(heavy.length).toBeGreaterThan(MAX_IMAGE_BYTES); // precondition: it really is over budget
    const out = await shrinkDataUrl(heavy);
    expect(out.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES); // converged into the byte budget
  });

  // Cheap byte-gate: an image comfortably under the byte budget is returned byte-identical WITHOUT a
  // re-encode — even if it's a PNG. Proves we don't decode/re-encode every small image every request.
  it("passes a within-budget image through untouched (no re-encode)", async () => {
    const small = await noisePngDataUrl(200, 200); // tiny, well under budget
    expect(small.length).toBeLessThan(MAX_IMAGE_BYTES);
    const out = await shrinkDataUrl(small);
    expect(out).toBe(small); // byte-identical, still a PNG — never decoded
  });

  it("returns the input unchanged when it isn't a base64 image data URL", async () => {
    const url = "https://example.com/cat.png";
    expect(await shrinkDataUrl(url)).toBe(url);
  });

  // A big image persists in history and is re-sent every turn — and Claude Code hits BOTH count_tokens
  // and messages each cycle. Without a cache, that's a ~2s decode+re-encode per turn per endpoint. The
  // result is cached by content, so the same image is shrunk ONCE and every later turn is a fast hit
  // returning the identical output. Assert: same output, and the second call is dramatically faster.
  it("caches by content — the same oversized image is only re-encoded once", async () => {
    const heavy = await noisePngDataUrl(MAX_IMAGE_EDGE, 1400);
    const t0 = performance.now();
    const first = await shrinkDataUrl(heavy);
    const firstMs = performance.now() - t0;
    const t1 = performance.now();
    const second = await shrinkDataUrl(heavy);
    const secondMs = performance.now() - t1;
    expect(second).toBe(first);                         // identical result
    expect(secondMs).toBeLessThan(firstMs / 5);         // cache hit is far cheaper than a re-encode
  });

  it("returns the input unchanged when the payload can't be decoded", async () => {
    const garbage = "data:image/png;base64,not-real-image-bytes";
    expect(await shrinkDataUrl(garbage)).toBe(garbage);
  });
});

describe("shrinkImagesInPlace", () => {
  it("rewrites over-budget image blocks across messages and leaves text untouched", async () => {
    const big = await noisePngDataUrl(3000, 3000);
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", dataUrl: big }] },
    ];
    await shrinkImagesInPlace(messages);
    const img = messages[0].content.find((b) => b.type === "image") as { dataUrl: string };
    expect(img.dataUrl.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(messages[0].content[0]).toEqual({ type: "text", text: "look" });
  });

  it("is a no-op for messages with no images", async () => {
    const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const before = JSON.stringify(messages);
    await shrinkImagesInPlace(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("shrinks images returned inside a tool_result (the readme-cover 502 path)", async () => {
    const big = await noisePngDataUrl(1800, 1200);
    const messages: CanonicalMessage[] = [
      { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "screenshot:", images: [big] }] },
    ];
    await shrinkImagesInPlace(messages);
    const tr = messages[0].content[0] as { images: string[]; content: string };
    expect(tr.content).toBe("screenshot:");        // text untouched
    expect(tr.images[0].startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(tr.images[0].length).toBeLessThan(big.length / 2);
  });
});
