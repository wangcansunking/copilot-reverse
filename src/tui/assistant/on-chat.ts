import type { AssistantConfig } from "./runtime.js";

type TurnRunner = (cfg: AssistantConfig, prompt: string, print: (l: string) => void) => Promise<void>;

export function makeOnChat(cfg: AssistantConfig, runner: TurnRunner) {
  return async (text: string, print: (line: string) => void, model?: string): Promise<void> => {
    try {
      await runner(model ? { ...cfg, model } : cfg, text, print);
    } catch (err) {
      print(`assistant error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
