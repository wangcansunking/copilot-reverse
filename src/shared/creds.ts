import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// M1: plaintext token in the data dir (0600). Encryption-at-rest is M2.
const file = (dir: string) => join(dir, "creds.json");
export function writeGhToken(token: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify({ ghToken: token }), { mode: 0o600 });
}
export function readGhToken(dir: string): string | null {
  if (!existsSync(file(dir))) return null;
  return (JSON.parse(readFileSync(file(dir), "utf8")) as { ghToken?: string }).ghToken ?? null;
}
