import type { AssistantConfig } from "./runtime.js";

type TurnRunner = (cfg: AssistantConfig, prompt: string, print: (l: string) => void, abort?: AbortController) => Promise<void>;

// Optional pre-flight check run before each turn. Returns a message to show (and block the turn) when
// the user can't chat yet — e.g. signed out or an expired Copilot login — or null to proceed.
type Precheck = () => Promise<string | null>;

const DEFAULT_TURN_TIMEOUT_MS = 120_000; // 2 minutes — a turn that hasn't replied by then is given up on

export function makeOnChat(cfg: AssistantConfig, runner: TurnRunner, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, precheck?: Precheck) {
  return async (text: string, print: (line: string) => void, model?: string, abort?: AbortController): Promise<void> => {
    // Gate the turn on auth before firing a doomed request. Without this, a signed-out user's message
    // hangs until the 120s timeout instead of getting an immediate, actionable hint.
    if (precheck) {
      const blocked = await precheck().catch(() => null); // a failed check must never wedge chat
      if (blocked) { print(blocked); return; }
    }
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
      const message = err instanceof Error ? err.message : String(err);
      print(`assistant error: ${message}`);
      // Detect an expired/revoked GitHub login anywhere in the error and steer the user to re-auth.
      if (/login expired|authentication_error|unauthorized|\b401\b|\b403\b|token exchange failed/i.test(message)) {
        print("\n  ↳ your GitHub login looks expired — run /login to sign in again");
      } else {
        print("\n  ↳ next: retry · /model to switch model · /doctor to check health · /report to file it");
      }
    }
  };
}
