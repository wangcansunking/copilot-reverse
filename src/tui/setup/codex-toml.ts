import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Codex reads ~/.codex/config.toml. copilot-reverse writes a managed provider block there (model,
// provider, context window) while preserving the user's other top-level keys. Mirrors
// agent-maestro's `configureCodex`. Codex removed wire_api="chat" (codex#7782), so we write
// "responses" and serve the OpenAI Responses API at /openai/responses (Codex appends /responses to
// base_url verbatim — no /v1 auto-added).
export const PROVIDER_ID = "copilot-reverse";

export function codexTomlPath(home = homedir()): string {
  return join(home, ".codex", "config.toml");
}

export interface CodexTomlOpts { home?: string; baseUrl: string; model: string; contextWindow?: number; apiKey?: string }

// The top-level keys we own (so re-applying replaces them instead of duplicating).
const MANAGED_TOP_KEYS = ["model", "model_provider", "model_context_window"];

export function applyCodexToml(opts: CodexTomlOpts): { path: string; changed: string[] } {
  const path = codexTomlPath(opts.home);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });

  // Parse existing content into top-level (pre-table) bare keys vs. table blocks, dropping our
  // managed keys and any prior managed provider table. We MUST keep top-level keys and tables
  // separate: in TOML a bare `key = value` after a `[table]` header belongs to that table, so
  // appending our `model_provider` at the end (after the user's [windows]/[marketplaces] tables)
  // silently nested it under the last table — Codex then couldn't see it and fell back to "openai".
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const keptTopKeys: string[] = [];   // bare key=value lines before any table
  const keptTables: string[] = [];    // everything from the first [table] onward (preserved verbatim)
  let inTable = false;                 // have we passed the first table header?
  let inOurTable = false;              // are we inside our own [model_providers.copilot-reverse] block?
  for (const line of existing.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
      inOurTable = line.trim() === `[model_providers.${PROVIDER_ID}]`;
    }
    if (inOurTable) continue; // skip our previously-written provider table entirely
    const keyMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    // Drop our managed top keys wherever they appear. They belong at the top level, but a previous
    // buggy version wrote them AFTER tables (where TOML nests them) — so filter them in the table
    // region too, otherwise the rewrite would duplicate them.
    if (keyMatch && MANAGED_TOP_KEYS.includes(keyMatch[1])) continue;
    (inTable ? keptTables : keptTopKeys).push(line);
  }

  // Reassemble in valid TOML order: ALL top-level keys (ours + the user's) first, then all table
  // blocks (the user's preserved tables, then our managed provider table last).
  const topKeys = [
    `model = "${opts.model}"`,
    `model_provider = "${PROVIDER_ID}"`,
    ...(opts.contextWindow ? [`model_context_window = ${opts.contextWindow}`] : []),
    ...keptTopKeys.filter((l) => l.trim()), // the user's other top-level keys (approval_policy, etc.)
  ];
  const ourTable = [
    `[model_providers.${PROVIDER_ID}]`,
    `name = "copilot-reverse"`,
    `base_url = "${opts.baseUrl}"`,
    `wire_api = "responses"`,
    // Auth: inline a static bearer token so Codex talks to our local proxy instead of falling back
    // to the OpenAI login flow. env_key is unreliable here (a standalone Codex CLI won't see our
    // .env), so we embed the placeholder directly — the worker ignores the key value anyway.
    `requires_openai_auth = false`,
    `experimental_bearer_token = "${opts.apiKey ?? "copilot-reverse-local"}"`,
  ];
  const userTables = keptTables.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const managed = [
    topKeys.join("\n"),
    ...(userTables ? [userTables] : []),
    ourTable.join("\n"),
  ].join("\n\n");

  const body = managed + "\n";
  writeFileSync(path, body);
  return { path, changed: MANAGED_TOP_KEYS };
}
