import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type Scope = "global" | "project";
export interface ApplyResult { path: string; changed: string[] }
export interface PlaceOpts { home?: string; cwd?: string }

// The env keys copilot-reverse writes for each client — so reset knows exactly what to remove.
// ANTHROPIC_AUTH_TOKEN isn't one we write, but reset strips it too: if it lingers alongside our
// API key, Claude Code warns "both set", so a clean reset should clear the conflict.
export const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_ATTRIBUTION_HEADER",
];
export const CODEX_ENV_KEYS = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"];

// --- Claude Code: merge into settings.json `env` (non-destructive) ---

export function claudePath(scope: Scope, o: PlaceOpts): string {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  return scope === "global" ? join(home, ".claude", "settings.json") : join(cwd, ".claude", "settings.json");
}

export function applyClaude(scope: Scope, env: Record<string, string>, o: PlaceOpts = {}): ApplyResult {
  const path = claudePath(scope, o);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { settings = {}; }
  }
  const envObj = (settings.env && typeof settings.env === "object" ? settings.env : {}) as Record<string, string>;
  const changed: string[] = [];
  // We authenticate with ANTHROPIC_API_KEY; a leftover ANTHROPIC_AUTH_TOKEN here makes Claude Code
  // warn "both set · auth may not work" — strip it so our setup leaves a clean, single-credential env.
  if ("ANTHROPIC_AUTH_TOKEN" in envObj) { delete envObj.ANTHROPIC_AUTH_TOKEN; changed.push("ANTHROPIC_AUTH_TOKEN(removed)"); }
  for (const [k, v] of Object.entries(env)) { if (envObj[k] !== v) { envObj[k] = v; changed.push(k); } }
  settings.env = envObj;
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { path, changed };
}

// Inverse of applyClaude: drop copilot-reverse's keys from settings.json `env`, keep everything else.
export function resetClaude(scope: Scope, keys: string[], o: PlaceOpts = {}): ApplyResult {
  const path = claudePath(scope, o);
  if (!existsSync(path)) return { path, changed: [] };
  let settings: Record<string, unknown>;
  try { settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return { path, changed: [] }; }
  const envObj = (settings.env && typeof settings.env === "object" ? settings.env : {}) as Record<string, string>;
  const changed: string[] = [];
  for (const k of keys) { if (k in envObj) { delete envObj[k]; changed.push(k); } }
  if (Object.keys(envObj).length) settings.env = envObj; else delete settings.env;
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { path, changed };
}

// --- Codex / OpenAI clients: merge into a .env file (non-destructive, line-wise) ---

export function codexPath(scope: Scope, o: PlaceOpts): string {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  return scope === "global" ? join(home, ".copilot-reverse", "codex.env") : join(cwd, ".env");
}

export function applyCodex(scope: Scope, env: Record<string, string>, o: PlaceOpts = {}): ApplyResult {
  const path = codexPath(scope, o);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const changed: string[] = [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && env[m[1]] !== undefined) {
      seen.add(m[1]);
      const nv = `${m[1]}=${env[m[1]]}`;
      if (line !== nv) changed.push(m[1]);
      return nv;
    }
    return line;
  });
  for (const [k, v] of Object.entries(env)) { if (!seen.has(k)) { out.push(`${k}=${v}`); changed.push(k); } }
  writeFileSync(path, out.join("\n").replace(/\n*$/, "\n"));
  return { path, changed };
}

// Inverse of applyCodex: drop copilot-reverse's KEY=value lines, keep every other line.
export function resetCodex(scope: Scope, keys: string[], o: PlaceOpts = {}): ApplyResult {
  const path = codexPath(scope, o);
  if (!existsSync(path)) return { path, changed: [] };
  const set = new Set(keys);
  const changed: string[] = [];
  const out = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && set.has(m[1])) { changed.push(m[1]); return false; }
    return true;
  });
  writeFileSync(path, out.join("\n").replace(/\n*$/, "\n"));
  return { path, changed };
}
