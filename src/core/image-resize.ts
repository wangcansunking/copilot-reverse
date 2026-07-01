import { Jimp, JimpMime } from "jimp";
import type { CanonicalMessage } from "./canonical.js";

// Why this exists: we sit where the real Anthropic backend used to, and that backend silently
// downscales oversized images before the model ever sees them. Copilot's /chat has NO such tiler for
// Claude models — it treats the inline `data:...;base64,...` URL as PLAIN TEXT and bills it at
// ~char/4. A single full-resolution screenshot (~9MB base64) is then ~2.3M tokens, blowing straight
// past the model's prompt limit ("model_max_prompt_tokens_exceeded"). So we take over the backend's
// job: decode → downscale → re-encode, shrinking the payload before it goes upstream.
//
// The gate + target are BYTES, not pixels. base64 length is what Copilot bills (char/4), so a photo
// whose long edge is already ≤ the pixel cap but whose BYTES are huge (a high-detail image a pixel
// gate would wave through) still blows the budget. We (a) short-circuit on base64 length so most
// images are never decoded, and (b) when over budget, downscale AND step JPEG quality/resolution
// DOWN until the encoded result actually fits the byte budget.

// Per-image base64 byte budget. Copilot bills base64 as ~char/4, so this cap ≈ MAX_IMAGE_BYTES/4
// tokens (~375k) — clean for a detailed screenshot yet far below the 936k prompt limit, leaving room
// for conversation text and multiple images. Images already under this are forwarded untouched.
export const MAX_IMAGE_BYTES = 1_500_000;
// Anthropic's long-edge cap (~1568px is its documented "no benefit beyond" size). The first downscale
// target; if the re-encode still overflows the byte budget we shrink further from here.
export const MAX_IMAGE_EDGE = 1568;
// JPEG quality ladder for the re-encode: try higher quality first, stepping down only as needed to
// reach the byte budget. Below the last rung we shrink the pixel dimensions instead.
const QUALITY_LADDER = [72, 55, 40, 28];
// When even the lowest quality overflows, scale the long edge down by this factor and retry the
// ladder — bounded so a pathological image still converges instead of looping forever.
const EDGE_STEP = 0.7;
const MIN_EDGE = 320;

// A base64 image data URL looks like `data:image/png;base64,<b64>`. Return the raw bytes, or null for
// anything we shouldn't touch (remote URLs, non-base64, or a malformed/undecodable payload).
function decodeBase64Image(dataUrl: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], "base64");
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

// The decoded-image type, taken straight from Jimp.fromBuffer's return so it matches jimp's own
// instance shape exactly (annotating it as InstanceType<typeof Jimp> drifts from what jimp infers).
type JimpImage = Awaited<ReturnType<typeof Jimp.fromBuffer>>;

// Re-encode an image down until its base64 fits MAX_IMAGE_BYTES: walk the quality ladder, and if the
// lowest quality still overflows, shrink the long edge and try again. Returns the smallest data URL
// found (guaranteed to terminate via the MIN_EDGE floor). Encoding is measured on the actual base64
// length, since that's the exact quantity Copilot bills.
async function encodeUnderBudget(img: JimpImage): Promise<string> {
  let best: string | undefined;
  let edge = Math.min(MAX_IMAGE_EDGE, Math.max(img.width, img.height));
  for (;;) {
    if (Math.max(img.width, img.height) > edge) img.scaleToFit({ w: edge, h: edge });
    for (const quality of QUALITY_LADDER) {
      const buf = await img.getBuffer(JimpMime.jpeg, { quality });
      const url = `data:image/jpeg;base64,${buf.toString("base64")}`;
      if (!best || url.length < best.length) best = url;
      if (url.length <= MAX_IMAGE_BYTES) return url;
    }
    const nextEdge = Math.floor(edge * EDGE_STEP);
    if (nextEdge < MIN_EDGE) return best!; // give up shrinking further — return the smallest we got
    edge = nextEdge;
  }
}

// Shrink one image data URL so its base64 fits the byte budget, re-encoding as JPEG. Cheap path first:
// non-images, remote URLs, undecodable payloads, and images already under budget are returned UNCHANGED
// (byte-identical) WITHOUT decoding, so the caller can blindly map over every image and small images
// cost nothing. Never throws: on any decode/encode failure we fall back to the original — a
// slightly-too-big image reaching the token pre-check is far better than a crashed request.
export async function shrinkDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.length <= MAX_IMAGE_BYTES) return dataUrl;        // byte short-circuit — no decode
  const bytes = decodeBase64Image(dataUrl);
  if (!bytes) return dataUrl;
  try {
    const img = await Jimp.fromBuffer(bytes);
    return await encodeUnderBudget(img);
  } catch {
    return dataUrl;
  }
}

// Rewrite every image block across a canonical message list in place, shrinking oversized images.
// Covers BOTH top-level image blocks AND images returned inside a tool_result (a Bash/MCP tool that
// emits a screenshot) — the latter was the real generate-readme-cover-images 502. Runs the images
// concurrently (decode/encode is CPU-bound but each is independent). Mutates the blocks so downstream
// token estimation and wire translation both see the reduced payload.
export async function shrinkImagesInPlace(messages: CanonicalMessage[]): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "image") {
        jobs.push(shrinkDataUrl(b.dataUrl).then((next) => { b.dataUrl = next; }));
      } else if (b.type === "tool_result" && b.images) {
        const imgs = b.images;
        imgs.forEach((url, i) => jobs.push(shrinkDataUrl(url).then((next) => { imgs[i] = next; })));
      }
    }
  }
  if (jobs.length) await Promise.all(jobs);
}
