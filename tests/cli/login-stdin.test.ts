import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real readline + inherited file descriptor + separate child, not a mocked prompt.
describe("first-login stdin handoff", () => {
  it("lets a fresh GHE child receive input after provider and hostname prompts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-stdin-"));
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/first-ghe-login.ts", import.meta.url)), dir], { stdio: "pipe" });
    let output = "", error = "", step = 0;
    child.stderr.on("data", (data) => { error += data; });
    child.stdout.on("data", (data) => {
      output += data;
      if (step === 0 && output.includes("Login provider:")) { step++; child.stdin.write("2\n"); }
      if (step === 1 && output.includes("GHE.com hostname")) { step++; child.stdin.write("acme.ghe.com\n"); }
      if (step === 2 && output.includes("GH_INPUT_READY")) { step++; child.stdin.write("authorize\n"); }
    });
    const timeout = setTimeout(() => child.kill(), 8000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(error).toBe("");
      expect(code, output).toBe(0);
      expect(output).toContain("GH_INPUT_RECEIVED");
      expect(output).toContain("LOGIN_COMPLETED true");
    } finally {
      clearTimeout(timeout);
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);
});
