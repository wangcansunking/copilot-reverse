import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(home: string = homedir()): string {
  return join(home, ".llm-maestro");
}
export function dbPath(home?: string): string {
  return join(dataDir(home), "maestro.db");
}
export function configPath(home?: string): string {
  return join(dataDir(home), "config.json");
}
