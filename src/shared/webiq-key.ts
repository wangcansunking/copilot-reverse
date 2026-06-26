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
