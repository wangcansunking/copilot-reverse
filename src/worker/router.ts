import type { ProviderAdapter } from "../providers/types.js";
import { bestModelMatch } from "../core/fuzzy.js";
import { FALLBACK_MODELS } from "../providers/copilot/models.js";
import { stripOneM, DEFAULT_ONE_M_MODELS } from "../core/model-canonical.js";

// M1: single provider. Model name is remapped to the provider's actual id.
export class Router {
  private available: string[] = [];
  // Dashed canonical ids advertising a ~1M window, from live discovery. Empty until the fetch resolves.
  private oneM = new Set<string>();
  constructor(private providers: ProviderAdapter[], private modelMap: Record<string, string>) {}
  // The live Copilot model list, used for fuzzy matching (set once fetched at worker startup).
  setAvailableModels(ids: string[]): void { this.available = ids; }
  // The set of models with a 1M window, from discovery. Ids arrive in Copilot's DOTTED form; store them
  // DASHED so is1M can compare against the canonical dashed ids the /v1/models mapper works with.
  setOneMModels(dottedIds: Iterable<string>): void {
    this.oneM = new Set([...dottedIds].map((id) => id.replace(/\./g, "-")));
  }
  // Oracle for toCanonical: is this DASHED canonical id a 1M model? Uses the live set once discovery has
  // populated it; before that (empty set) it falls back to the hardcoded defaults, so a known 1M model
  // never briefly loses its badge during startup — mirrors the reasoning gate's "empty ⇒ default" guard.
  is1M(dashed: string): boolean {
    return this.oneM.size ? this.oneM.has(dashed) : DEFAULT_ONE_M_MODELS.has(dashed);
  }
  // Model ids to advertise from the /models discovery endpoints. Falls back to a curated list
  // until the live fetch resolves, so discovery never returns an empty list.
  listModels(): string[] { return this.available.length ? this.available : FALLBACK_MODELS; }
  resolveModel(requested: string): string {
    // Claude Code appends [1m] to signal its 1M context window; Copilot doesn't know that id, so
    // strip it back to the canonical model before mapping/forwarding.
    requested = stripOneM(requested);
    const mapped = this.modelMap[requested];
    if (mapped) return mapped;
    // Fuzzy-match a near-miss id (e.g. canonical claude-opus-4-8 -> Copilot claude-opus-4.8) to a real model.
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
