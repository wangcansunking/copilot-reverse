import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import { UpstreamError } from "../../src/providers/copilot/adapter.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

// Opt-in real CLI, local provider only: no model quota, credentials, writes or user session reuse.
const binary = process.env.COMPACTION_TEST_CLAUDE;
describe.skipIf(!binary)("real Claude compaction", () => {
  it.each(["auto", "overflow"])("compacts multi-turn replay and continues after %s", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "cr-compact-"));
    let calls = 0, summaries = 0, overflow = false;
    const provider: ProviderAdapter = {
      name: "fixture",
      async complete(req) {
        const text = req.messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
        if (!/Do NOT call any tools|summarize the conversation/i.test(text)) {
          throw new UpstreamError(400, "Your input exceeds the context window of this model. Please adjust your input and try again.");
        }
        summaries++;
        return { id: `summary_${summaries}`, model: req.model, content: [{ type: "text", text: "<summary>We read package.json. Reply COMPACT_OK. No tools needed.</summary>" }], finishReason: "stop", usage: { promptTokens: 100, completionTokens: 30 } };
      },
      async *stream(req) {
        const text = req.messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
        if (/Do NOT call any tools|summarize the conversation/i.test(text)) {
          summaries++;
          yield { kind: "text", delta: "<summary>We read package.json. Reply COMPACT_OK.</summary>", done: false };
          yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 30 } };
          return;
        }
        calls++;
        if (calls <= 6) {
          yield { kind: "tool_use_start", id: `read_${calls}`, index: 0, name: "Read", done: false };
          yield { kind: "tool_use_delta", index: 0, argsDelta: JSON.stringify({ file_path: join(process.cwd(), "package.json") }), done: false };
          yield { kind: "done", done: true, finishReason: "tool_use", usage: { promptTokens: mode === "auto" && calls === 6 ? 850_000 : 1000, completionTokens: 30 } };
        } else if (mode === "overflow" && !overflow) {
          overflow = true;
          throw new UpstreamError(400, "Your input exceeds the context window of this model. Please adjust your input and try again.");
        } else {
          yield { kind: "text", delta: "COMPACT_OK", done: false };
          yield { kind: "done", done: true, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 30 } };
        }
      },
    };
    const server = createWorkerApp(new Router([provider], { "claude-opus-5": "gpt-6-sol" }), () => {}).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|DISABLE_|CLAUDECODE)/.test(key)) delete env[key];
    env.ANTHROPIC_CONFIG_DIR = dir;
    const child = spawn(binary!, ["--bare", "--setting-sources", "", "--settings", JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_API_KEY: "fixture",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "922000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
    } }), "-p", "Read package.json then reply COMPACT_OK", "--model", "claude-opus-5[1m]", "--tools", "Read", "--allowedTools", "Read", "--system-prompt", "Follow the user's request.", "--output-format", "stream-json", "--verbose", "--no-session-persistence"], { env, stdio: "pipe" });
    child.stdin.end();
    let output = "", error = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { error += data; });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      expect(code, error + output.slice(-2000)).toBe(0);
      const events = output.trim().split("\n").map((line) => JSON.parse(line));
      expect(events.some((e) => e.subtype === "compact_boundary"), output.slice(-2000)).toBe(true);
      expect(summaries).toBeGreaterThan(0);
      expect(events.at(-1).is_error).toBe(false);
      expect(events.at(-1).result).toContain("COMPACT_OK");
      if (mode === "overflow") expect(overflow).toBe(true);
    } finally {
      clearTimeout(timer);
      child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
