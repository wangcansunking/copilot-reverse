import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// WebIQ config for the gateway-run web_search / web_fetch tools: the API key plus the active backend
// MODE. Stored like the GitHub token (plaintext, 0600, in the data dir). The WEBIQ_API_KEY env var
// takes precedence for the key so CI / headless runs can inject it. Read lazily per request → no
// worker restart on change.
//
//   mode "copilot" (DEFAULT) — borrow gpt-5-mini's native web_search; no key needed.
//   mode "webiq"             — force ALL models through WebIQ using the stored key.
const file = (dir: string) => join(dir, "webiq.json");
export type WebSearchMode = "copilot" | "webiq";

interface WebIqFile { apiKey?: string; mode?: WebSearchMode }
function read(dir: string): WebIqFile {
  if (!existsSync(file(dir))) return {};
  try { return JSON.parse(readFileSync(file(dir), "utf8")) as WebIqFile; } catch { return {}; }
}
function write(dir: string, data: WebIqFile): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(data), { mode: 0o600 });
}

export function writeWebIqKey(key: string, dir: string): void {
  write(dir, { ...read(dir), apiKey: key });
}
export function readWebIqKey(dir: string): string | null {
  if (process.env.WEBIQ_API_KEY) return process.env.WEBIQ_API_KEY;
  return read(dir).apiKey ?? null;
}
// Reset everything — drop the key AND revert to the default copilot backend.
export function clearWebIqKey(dir: string): void {
  rmSync(file(dir), { force: true });
}

export function readWebSearchMode(dir: string): WebSearchMode {
  return read(dir).mode === "webiq" ? "webiq" : "copilot";
}
export function writeWebSearchMode(dir: string, mode: WebSearchMode): void {
  write(dir, { ...read(dir), mode });
}

// Master switch for the Copilot "borrow" backend (gpt-5-mini's native web_search). Currently OFF:
// gpt-5-mini is badly congested on Copilot's /responses (503 "high demand", 20s–7min), while WebIQ is
// sub-second. So web search routes through WebIQ only; with no key it is unavailable. Flip this to
// `true` to bring borrow search back (the borrow code path is kept intact). NOTE: this gates only the
// Claude gateway backend — Codex's native /responses web_search is unaffected (it uses fast gpt-5
// models directly, not gpt-5-mini).
export const COPILOT_WEB_SEARCH_ENABLED = false;

export type WebSearchBackend = "copilot" | "webiq" | "unavailable";

// Resolve which backend a gateway web_search/web_fetch call should use. Pure (no I/O) so both flag
// states are unit-tested. `enabled` defaults to the live flag; tests pass it explicitly.
export function resolveWebSearchBackend(mode: WebSearchMode, hasKey: boolean, enabled: boolean = COPILOT_WEB_SEARCH_ENABLED): WebSearchBackend {
  if (!enabled) return hasKey ? "webiq" : "unavailable"; // borrow disabled → WebIQ or nothing
  if (mode === "webiq" && hasKey) return "webiq";
  return "copilot"; // default borrow (and the webiq-without-key fallback)
}
