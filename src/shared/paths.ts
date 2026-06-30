import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProfile, profileDataDir } from "./profile.js";

// The active instance's data dir. Derived from the profile (COPILOT_REVERSE_PROFILE / *_DATA_DIR) so a
// dev instance lives in ~/.copilot-reverse-dev while the default (prod) profile stays at
// ~/.copilot-reverse, byte-identical to before. Every store reads through here, so this one line
// isolates the whole on-disk surface (token, db, access key, client-setup) per profile.
export function dataDir(home: string = homedir()): string {
  return profileDataDir(resolveProfile(), home);
}
export function dbPath(home?: string): string {
  return join(dataDir(home), "copilot-reverse.db");
}
export function configPath(home?: string): string {
  return join(dataDir(home), "config.json");
}
