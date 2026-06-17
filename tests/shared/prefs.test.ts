import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChatModel, writeChatModel } from "../../src/shared/prefs.js";

describe("prefs", () => {
  it("round-trips the chat model", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(readChatModel(d)).toBeNull();
    writeChatModel(d, "gpt-4o");
    expect(readChatModel(d)).toBe("gpt-4o");
  });
  it("preserves other prefs keys on write", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ other: 1 }));
    writeChatModel(d, "claude-sonnet-4");
    const raw = JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"));
    expect(raw.other).toBe(1);
    expect(raw.chatModel).toBe("claude-sonnet-4");
  });
});
