import { describe, it, expect, vi } from "vitest";
import { makeOnChat } from "../../src/tui/assistant/on-chat.js";

describe("makeOnChat", () => {
  it("forwards text + print to the turn runner", async () => {
    const runner = vi.fn(async (_cfg, prompt: string, print: (l: string) => void) => { print(`echo:${prompt}`); });
    const printed: string[] = [];
    const onChat = makeOnChat({ client: {} as any, workerBaseUrl: "http://x", apiKey: "k", model: "m" }, runner as any);
    await onChat("hello", (l) => printed.push(l));
    expect(printed).toContain("echo:hello");
  });
  it("prints a red-line error when the runner throws", async () => {
    const runner = vi.fn(async () => { throw new Error("boom"); });
    const printed: string[] = [];
    const onChat = makeOnChat({ client: {} as any, workerBaseUrl: "http://x", apiKey: "k", model: "m" }, runner as any);
    await onChat("hi", (l) => printed.push(l));
    expect(printed.join("\n")).toMatch(/assistant error: boom/);
  });
});
