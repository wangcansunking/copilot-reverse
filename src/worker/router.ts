import type { ProviderAdapter } from "../providers/types.js";

// M1: single provider. Model name is remapped to the provider's actual id.
export class Router {
  constructor(private providers: ProviderAdapter[], private modelMap: Record<string, string>) {}
  resolveModel(requested: string): string {
    return this.modelMap[requested] ?? this.modelMap["*"] ?? requested;
  }
  pick(_model: string): ProviderAdapter {
    const p = this.providers[0];
    if (!p) throw new Error("no provider registered");
    return p;
  }
}
