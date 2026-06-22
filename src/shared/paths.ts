import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(home: string = homedir()): string {
  return join(home, ".copilot-reverse");
}
export function dbPath(home?: string): string {
  return join(dataDir(home), "copilot-reverse.db");
}
export function configPath(home?: string): string {
  return join(dataDir(home), "config.json");
}
