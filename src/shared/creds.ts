import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// M1: plaintext token in the data dir (0600). Encryption-at-rest is M2.
const file = (dir: string) => join(dir, "creds.json");
export function writeGhToken(token: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify({ ghToken: token }), { mode: 0o600 });
}
export function readGhToken(dir: string): string | null {
  if (!existsSync(file(dir))) return null;
  // A corrupt creds.json (partial write) or a transient read failure (Windows EBUSY/EPERM when an
  // antivirus or a concurrent /login write holds the file) must not throw: this is called from the
  // 60s heartbeat tick whose rejection would otherwise reach the process top level and kill the TUI.
  // Treat an unreadable file as "no token" — the next clean read recovers it.
  try {
    return (JSON.parse(readFileSync(file(dir), "utf8")) as { ghToken?: string }).ghToken ?? null;
  } catch {
    return null;
  }
}
// Remove the stored token (logout). No-op if there's nothing to remove.
export function clearGhToken(dir: string): void {
  rmSync(file(dir), { force: true });
}
