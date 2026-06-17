import type { AssistantConfig } from "./runtime.js";

type TurnRunner = (cfg: AssistantConfig, prompt: string, print: (l: string) => void) => Promise<void>;

export function makeOnChat(cfg: AssistantConfig, runner: TurnRunner) {
  return async (text: string, print: (line: string) => void): Promise<void> => {
    try {
      await runner(cfg, text, print);
    } catch (err) {
      print(`assistant error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
