import type { CanonicalRequest, CanonicalResponse, CanonicalChunk } from "../core/canonical.js";
export interface ProviderAdapter {
  readonly name: string;
  complete(req: CanonicalRequest): Promise<CanonicalResponse>;
  stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk>;
}
