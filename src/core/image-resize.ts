import { Jimp, JimpMime } from "jimp";
import type { CanonicalMessage } from "./canonical.js";

// Why this exists: we sit where the real Anthropic backend used to, and that backend silently
// downscales oversized images before the model ever sees them (long edge ≤ ~1568px). Copilot's
// /chat has NO such tiler for Claude models — it treats the inline `data:...;base64,...` URL as
// PLAIN TEXT and bills it at ~char/4. A single full-resolution screenshot (~9MB base64) is then
// ~2.3M tokens, blowing straight past the model's prompt limit ("model_max_prompt_tokens_exceeded").
// So we take over the backend's job: decode → downscale → re-encode, shrinking the payload by ~50x
// before it goes upstream. This mirrors Claude Code's own reliance on backend-side image transforms.

// Anthropic's long-edge cap (~1568px is its documented "no benefit beyond" size). Matching it keeps
// visual fidelity identical to a direct-to-Anthropic call while collapsing the byte count.
export const MAX_IMAGE_EDGE = 1568;
// JPEG quality for re-encode. 72 is visually clean for screenshots/photos and roughly an order of
// magnitude smaller than the source PNG — the payload reduction, not pixel-perfection, is the point.
const JPEG_QUALITY = 72;

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

// Downscale one image data URL so its long edge is ≤ MAX_IMAGE_EDGE, re-encoding as JPEG to shed the
// bulk of the bytes. Non-images, remote URLs, undecodable payloads, and already-small images are
// returned UNCHANGED (byte-identical) so the caller can blindly map over every image without special
// cases. Never throws: on any decode/encode failure we fall back to the original — a slightly-too-big
// image reaching the token pre-check is far better than a crashed request.
export async function shrinkDataUrl(dataUrl: string): Promise<string> {
  const bytes = decodeBase64Image(dataUrl);
  if (!bytes) return dataUrl;
  try {
    const img = await Jimp.fromBuffer(bytes);
    if (Math.max(img.width, img.height) <= MAX_IMAGE_EDGE) return dataUrl; // already within budget
    img.scaleToFit({ w: MAX_IMAGE_EDGE, h: MAX_IMAGE_EDGE });
    const out = await img.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return dataUrl;
  }
}

// Rewrite every image block across a canonical message list in place, shrinking oversized images.
// Runs the images concurrently (decode/encode is CPU-bound but each is independent). Mutates the
// blocks so downstream token estimation and wire translation both see the reduced payload.
export async function shrinkImagesInPlace(messages: CanonicalMessage[]): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "image") {
        jobs.push(shrinkDataUrl(b.dataUrl).then((next) => { b.dataUrl = next; }));
      }
    }
  }
  if (jobs.length) await Promise.all(jobs);
}
