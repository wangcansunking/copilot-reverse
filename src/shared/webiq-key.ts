import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// WebIQ API key for the gateway-run web_search / web_fetch tools. Stored like the GitHub token
// (plaintext, 0600, in the data dir). The WEBIQ_API_KEY env var takes precedence so CI / headless
// runs can inject it without writing a file. Read lazily per request → no worker restart on change.
const file = (dir: string) => join(dir, "webiq.json");

export function writeWebIqKey(key: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify({ apiKey: key }), { mode: 0o600 });
}
export function readWebIqKey(dir: string): string | null {
  if (process.env.WEBIQ_API_KEY) return process.env.WEBIQ_API_KEY;
  if (!existsSync(file(dir))) return null;
  return (JSON.parse(readFileSync(file(dir), "utf8")) as { apiKey?: string }).apiKey ?? null;
}
export function clearWebIqKey(dir: string): void {
  rmSync(file(dir), { force: true });
}
