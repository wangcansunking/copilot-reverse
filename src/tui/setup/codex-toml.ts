import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Codex reads ~/.codex/config.toml. copilot-reverse writes a managed provider block there (model,
// provider, context window) while preserving the user's other top-level keys. Mirrors
// agent-maestro's `configureCodex`, but uses wire_api="chat" since our proxy is chat/completions.
export const PROVIDER_ID = "copilot-reverse";

export function codexTomlPath(home = homedir()): string {
  return join(home, ".codex", "config.toml");
}

export interface CodexTomlOpts { home?: string; baseUrl: string; model: string; contextWindow?: number }

// The top-level keys we own (so re-applying replaces them instead of duplicating).
const MANAGED_TOP_KEYS = ["model", "model_provider", "model_context_window"];

export function applyCodexToml(opts: CodexTomlOpts): { path: string; changed: string[] } {
  const path = codexTomlPath(opts.home);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });

  // Read existing top-level lines, dropping our managed keys and any prior managed provider table,
  // but keeping everything else (approval_policy, other providers, etc.) verbatim.
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const kept: string[] = [];
  let inOurTable = false;
  for (const line of existing.split(/\r?\n/)) {
    const tableMatch = /^\s*\[/.test(line);
    if (tableMatch) inOurTable = line.trim() === `[model_providers.${PROVIDER_ID}]`;
    if (inOurTable) continue; // skip our previously-written provider table
    const keyMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (keyMatch && MANAGED_TOP_KEYS.includes(keyMatch[1])) continue; // skip our managed top keys
    kept.push(line);
  }

  const head = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const managed = [
    `model = "${opts.model}"`,
    `model_provider = "${PROVIDER_ID}"`,
    ...(opts.contextWindow ? [`model_context_window = ${opts.contextWindow}`] : []),
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "copilot-reverse"`,
    `base_url = "${opts.baseUrl}"`,
    `wire_api = "chat"`,
  ].join("\n");

  const body = (head ? `${head}\n\n` : "") + managed + "\n";
  writeFileSync(path, body);
  return { path, changed: MANAGED_TOP_KEYS };
}
