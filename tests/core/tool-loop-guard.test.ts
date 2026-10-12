import { describe, expect, it } from "vitest";
import type { CanonicalMessage } from "../../src/core/canonical.js";
import { repeatedEditLoop } from "../../src/core/tool-loop-guard.js";

function edits(count = 12): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "Fix the tests" }] }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "Edit", input: {
      file_path: "/project/test.mjs", replace_all: false,
      old_string: `const invalid = { slice: 'VS999' }; tagged${i}.`,
      new_string: `const invalid = { slice: 'VS999' }; tagged${i + 1}.`,
    } }] });
    messages.push({ role: "tool", content: [{ type: "tool_result", toolUseId: `call_${i}`, content: "File updated successfully" }] });
  }
  return messages;
}

describe("cross-request repeated Edit guard", () => {
  it("detects the numeric-tail edit loop from the failed session", () => {
    expect(repeatedEditLoop(edits())).toBe(true);
  });
  it("tolerates the automatic token reminders present in the real session", () => {
    const history = edits().flatMap((message) => message.role === "tool"
      ? [message, { role: "user" as const, content: [{ type: "text" as const, text: "<total_tokens>14000000 tokens left</total_tokens>" }] }]
      : [message]);
    expect(repeatedEditLoop(history)).toBe(true);
  });
  it("handles a token reminder merged into the same tool-result message", () => {
    const history = edits();
    for (const message of history) if (message.role === "tool") message.content.push({ type: "text", text: "<system-reminder><total_tokens>14000000 tokens left</total_tokens></system-reminder>" });
    expect(repeatedEditLoop(history)).toBe(true);
  });
  it("respects a real user instruction merged with a tool result", () => {
    const history = edits();
    history.at(-1)!.content.push({ type: "text", text: "Stop editing. Check the tests." });
    expect(repeatedEditLoop(history)).toBe(false);
  });
  it("does not block a short sequence", () => {
    expect(repeatedEditLoop(edits(11))).toBe(false);
  });
  it("does not block new user instructions or compaction", () => {
    const history = edits();
    history.push({ role: "user", content: [{ type: "text", text: "Summarize this conversation" }] });
    expect(repeatedEditLoop(history)).toBe(false);
  });
  it("does not block normal batch edits of different files", () => {
    const history = edits();
    for (let i = 1; i < history.length; i += 2) {
      const tool = history[i].content[0];
      if (tool.type === "tool_use") tool.input = { ...tool.input as object, file_path: `/project/test${i}.mjs` };
    }
    expect(repeatedEditLoop(history)).toBe(false);
  });
  it("does not block materially different edits in the same file", () => {
    const history = edits();
    const tool = history[history.length - 2].content[0];
    if (tool.type === "tool_use") tool.input = { file_path: "/project/test.mjs", old_string: "wrong", new_string: "right" };
    expect(repeatedEditLoop(history)).toBe(false);
  });
  it("does not classify failed or unmatched tool results as progress", () => {
    const history = edits();
    const result = history[history.length - 1].content[0];
    if (result.type === "tool_result") result.isError = true;
    expect(repeatedEditLoop(history)).toBe(false);
    if (result.type === "tool_result") { result.isError = false; result.toolUseId = "unmatched"; }
    expect(repeatedEditLoop(history)).toBe(false);
  });
  it("requires a connected old/new chain, not just similar numeric edits", () => {
    const history = edits();
    const tool = history[history.length - 2].content[0];
    if (tool.type === "tool_use") tool.input = { ...tool.input as object, old_string: "const invalid = { slice: 'VS999' }; tagged100." };
    expect(repeatedEditLoop(history)).toBe(false);
  });
  it("has no shared state across sessions", () => {
    expect(repeatedEditLoop(edits())).toBe(true);
    expect(repeatedEditLoop(edits(1))).toBe(false);
  });
});
