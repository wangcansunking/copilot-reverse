import type { AssistantConfig } from "./runtime.js";

type TurnRunner = (cfg: AssistantConfig, prompt: string, print: (l: string) => void, abort?: AbortController) => Promise<void>;

const DEFAULT_TURN_TIMEOUT_MS = 120_000; // 2 minutes — a turn that hasn't replied by then is given up on

export function makeOnChat(cfg: AssistantConfig, runner: TurnRunner, timeoutMs = DEFAULT_TURN_TIMEOUT_MS) {
  return async (text: string, print: (line: string) => void, model?: string, abort?: AbortController): Promise<void> => {
    const ctrl = abort ?? new AbortController();
    let timedOut = false;
    // Race the turn against a hard timeout so a hung SDK/upstream can never block the UI forever.
    // We also abort the controller to try to stop the underlying work.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => { timedOut = true; ctrl.abort(); reject(new Error("turn timeout")); }, timeoutMs),
    );
    try {
      await Promise.race([runner(model ? { ...cfg, model } : cfg, text, print, ctrl), timeout]);
    } catch (err) {
      if (timedOut) { print(`⎿ no response after ${Math.round(timeoutMs / 1000)}s — gave up (try again or pick a different model)`); return; }
      if (ctrl.signal.aborted) { print("⎿ interrupted"); return; }
      print(`assistant error: ${err instanceof Error ? err.message : String(err)}`);
      print("\n  ↳ next: retry · /model to switch model · /doctor to check health · /report to file it");
    }
  };
}
