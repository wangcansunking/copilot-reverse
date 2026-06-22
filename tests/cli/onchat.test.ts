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

  it("gives up (and aborts) when a turn exceeds the timeout", async () => {
    // a runner that never resolves on its own — only the timeout can end it
    const runner = vi.fn((_c: any, _p: string, _print: any, abort?: AbortController) =>
      new Promise<void>((_resolve, reject) => abort?.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const printed: string[] = [];
    const onChat = makeOnChat({ client: {} as any, workerBaseUrl: "http://x", apiKey: "k", model: "m" }, runner as any, 20);
    await onChat("hi", (l) => printed.push(l));
    expect(printed.join("\n")).toMatch(/no response after .*gave up/);
  });

  it("reports a user interrupt distinctly from an error", async () => {
    const runner = vi.fn((_c: any, _p: string, _print: any, abort?: AbortController) =>
      new Promise<void>((_resolve, reject) => abort?.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const printed: string[] = [];
    const ctrl = new AbortController();
    const onChat = makeOnChat({ client: {} as any, workerBaseUrl: "http://x", apiKey: "k", model: "m" }, runner as any);
    const p = onChat("hi", (l) => printed.push(l), undefined, ctrl);
    ctrl.abort();
    await p;
    expect(printed.join("\n")).toMatch(/interrupted/);
  });
});
