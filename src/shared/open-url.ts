import { spawn } from "node:child_process";

export interface OpenCommand { command: string; args: string[] }

// The platform's URL-opening command. Pure + exported so it can be asserted without spawning.
export function openCommandFor(url: string, platform: NodeJS.Platform = process.platform): OpenCommand {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

// Best-effort: open the URL in the user's default browser. Never throws — if no opener
// exists (headless box), the caller's printed URL is the fallback.
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  const { command, args } = openCommandFor(url, platform);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => { /* no opener available; ignore */ });
  child.unref();
}
