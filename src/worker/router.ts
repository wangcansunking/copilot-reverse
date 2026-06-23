import type { ProviderAdapter } from "../providers/types.js";
import { bestModelMatch } from "../core/fuzzy.js";
import { FALLBACK_MODELS } from "../providers/copilot/models.js";

// M1: single provider. Model name is remapped to the provider's actual id.
export class Router {
  private available: string[] = [];
  constructor(private providers: ProviderAdapter[], private modelMap: Record<string, string>) {}
  // The live Copilot model list, used for fuzzy matching (set once fetched at worker startup).
  setAvailableModels(ids: string[]): void { this.available = ids; }
  // Model ids to advertise from the /models discovery endpoints. Falls back to a curated list
  // until the live fetch resolves, so discovery never returns an empty list.
  listModels(): string[] { return this.available.length ? this.available : FALLBACK_MODELS; }
  resolveModel(requested: string): string {
    // Claude Code appends [1m] to signal its 1M context window; Copilot doesn't know that id, so
    // strip it back to the real model before mapping/forwarding.
    requested = requested.endsWith("[1m]") ? requested.slice(0, -4) : requested;
    const mapped = this.modelMap[requested];
    if (mapped) return mapped;
    // Fuzzy-match a near-miss id (e.g. claude-opus-4-8-20251101 -> claude-opus-4.8) to a real model.
    if (this.available.length) {
      const match = bestModelMatch(requested, this.available);
      if (match) return match;
    }
    return this.modelMap["*"] ?? requested;
  }
  pick(_model: string): ProviderAdapter {
    const p = this.providers[0];
    if (!p) throw new Error("no provider registered");
    return p;
  }
}
