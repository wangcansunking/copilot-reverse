import { describe, it, expect } from "vitest";
import { textContent, joinText } from "../../src/core/canonical.js";
import type { ContentBlock } from "../../src/core/canonical.js";

describe("canonical helpers", () => {
  it("textContent wraps a string in a single text block", () => {
    expect(textContent("hi")).toEqual([{ type: "text", text: "hi" }]);
  });
  it("joinText concatenates only text blocks, ignoring tool/image blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "a" },
      { type: "image", dataUrl: "data:image/png;base64,X" },
      { type: "tool_use", id: "t", name: "n", input: {} },
      { type: "text", text: "b" },
    ];
    expect(joinText(blocks)).toBe("ab");
  });
  it("joinText returns empty string when there are no text blocks", () => {
    expect(joinText([{ type: "image", dataUrl: "x" }])).toBe("");
  });
  it("joinText ignores thinking blocks (reasoning is not assistant-visible answer text)", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", text: "let me reason", opaque: "sig" },
      { type: "text", text: "answer" },
    ];
    expect(joinText(blocks)).toBe("answer");
  });
});
