import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Whether the user has applied copilot-reverse config for each client. Surfaced in the TUI HUD;
// written by the /setup-* flow once it actually applies config.
export interface ClientSetupState { claude: boolean; codex: boolean }

const file = (dir: string) => join(dir, "clients.json");

export function readClientSetup(dir: string): ClientSetupState {
  if (!existsSync(file(dir))) return { claude: false, codex: false };
  try {
    const d = JSON.parse(readFileSync(file(dir), "utf8")) as Partial<ClientSetupState>;
    return { claude: Boolean(d.claude), codex: Boolean(d.codex) };
  } catch {
    return { claude: false, codex: false };
  }
}

export function writeClientSetup(dir: string, state: ClientSetupState): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(state));
}
