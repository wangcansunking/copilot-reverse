import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type Scope = "global" | "project";
export interface ApplyResult { path: string; changed: string[] }
export interface PlaceOpts { home?: string; cwd?: string }

// --- Claude Code: merge into settings.json `env` (non-destructive) ---

function claudePath(scope: Scope, o: PlaceOpts): string {
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
  for (const [k, v] of Object.entries(env)) { if (envObj[k] !== v) { envObj[k] = v; changed.push(k); } }
  settings.env = envObj;
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { path, changed };
}

// --- Codex / OpenAI clients: merge into a .env file (non-destructive, line-wise) ---

function codexPath(scope: Scope, o: PlaceOpts): string {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  return scope === "global" ? join(home, ".llm-maestro", "codex.env") : join(cwd, ".env");
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
