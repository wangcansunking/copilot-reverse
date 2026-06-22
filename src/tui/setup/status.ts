import { existsSync, readFileSync } from "node:fs";
import { claudePath, codexPath, type Scope } from "./apply.js";

// HUD status derived from the REAL config files (not a remembered command flag), per scope.
export interface ScopeStatus { user: boolean; project: boolean }
export interface ClientStatus { claude: ScopeStatus; codex: ScopeStatus }
export interface StatusOpts { home?: string; cwd?: string }

// A copilot-reverse-written endpoint always points at the local loopback proxy — this lets us tell our
// own config apart from a user's pre-existing ANTHROPIC_BASE_URL / OPENAI_BASE_URL.
const isCopilotReverse = (v: unknown): boolean => typeof v === "string" && /127\.0\.0\.1|localhost/.test(v);

function claudeConfigured(scope: Scope, o: StatusOpts): boolean {
  const p = claudePath(scope, o);
  if (!existsSync(p)) return false;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as { env?: Record<string, unknown> };
    return isCopilotReverse(s.env?.ANTHROPIC_BASE_URL);
  } catch { return false; }
}

function codexConfigured(scope: Scope, o: StatusOpts): boolean {
  const p = codexPath(scope, o);
  if (!existsSync(p)) return false;
  try {
    const m = /^OPENAI_BASE_URL=(.*)$/m.exec(readFileSync(p, "utf8"));
    return !!m && isCopilotReverse(m[1]);
  } catch { return false; }
}

export function readClientStatus(o: StatusOpts = {}): ClientStatus {
  return {
    claude: { user: claudeConfigured("global", o), project: claudeConfigured("project", o) },
    codex: { user: codexConfigured("global", o), project: codexConfigured("project", o) },
  };
}
