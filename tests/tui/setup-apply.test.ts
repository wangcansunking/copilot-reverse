import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCopilotModels, fetchModelLimits } from "../../src/providers/copilot/models.js";
import { applyClaude, applyCodex, resetClaude, resetCodex, CLAUDE_ENV_KEYS, CODEX_ENV_KEYS } from "../../src/tui/setup/apply.js";
import { vi } from "vitest";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("fetchCopilotModels", () => {
  it("returns ids from the live list", async () => {
    const f = vi.fn(async () => json({ data: [{ id: "gpt-4o" }, { id: "claude-opus-4-8" }] }));
    expect(await fetchCopilotModels("cop", f as unknown as typeof fetch)).toEqual(["gpt-4o", "claude-opus-4-8"]);
  });
  it("falls back when endpoint fails", async () => {
    const f = vi.fn(async () => json({}, 500));
    const out = await fetchCopilotModels("cop", f as unknown as typeof fetch);
    expect(out).toContain("gpt-4o");
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("fetchModelLimits", () => {
  it("maps model id -> max input/context tokens", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "gpt-4o", capabilities: { limits: { max_prompt_tokens: 128000 } } },
      { id: "claude-opus-4-8", capabilities: { limits: { max_context_window_tokens: 200000 } } },
    ] }));
    const map = await fetchModelLimits("cop", f as unknown as typeof fetch);
    expect(map["gpt-4o"]).toBe(128000);
    expect(map["claude-opus-4-8"]).toBe(200000);
  });
  it("returns an empty map when the endpoint fails", async () => {
    const f = vi.fn(async () => json({}, 500));
    expect(await fetchModelLimits("cop", f as unknown as typeof fetch)).toEqual({});
  });
});

describe("applyClaude", () => {
  it("creates settings.json with merged env (project scope)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    const r = applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k" }, { cwd });
    expect(r.path).toBe(join(cwd, ".claude", "settings.json"));
    expect(r.changed).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.env.ANTHROPIC_BASE_URL).toBe("http://x");
  });
  it("merges non-destructively into existing settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "1" } }));
    const r = applyClaude("project", { ANTHROPIC_BASE_URL: "http://x" }, { cwd });
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.theme).toBe("dark");       // preserved
    expect(s.env.KEEP).toBe("1");        // preserved
    expect(s.env.ANTHROPIC_BASE_URL).toBe("http://x"); // added
    expect(r.changed).toEqual(["ANTHROPIC_BASE_URL"]);
  });
});

describe("applyCodex", () => {
  it("writes/merges .env line-wise without clobbering other lines", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, ".env"), "EXISTING=1\nOPENAI_BASE_URL=old\n");
    const r = applyCodex("project", { OPENAI_BASE_URL: "http://x/v1", OPENAI_API_KEY: "k" }, { cwd });
    const txt = readFileSync(join(cwd, ".env"), "utf8");
    expect(txt).toContain("EXISTING=1");          // preserved
    expect(txt).toContain("OPENAI_BASE_URL=http://x/v1"); // replaced
    expect(txt).toContain("OPENAI_API_KEY=k");     // added
    expect(r.changed).toContain("OPENAI_BASE_URL");
    expect(r.changed).toContain("OPENAI_API_KEY");
  });
});

describe("resetClaude", () => {
  it("removes maestro's env keys but preserves other settings and env keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "gpt-4o" }, { cwd });
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "1", ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "gpt-4o" } }));
    const r = resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.theme).toBe("dark");                 // preserved
    expect(s.env.KEEP).toBe("1");                 // preserved
    expect(s.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(s.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(r.changed.sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
  });
  it("is a no-op when settings.json does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    const r = resetClaude("project", CLAUDE_ENV_KEYS, { cwd });
    expect(r.changed).toEqual([]);
  });
});

describe("resetCodex", () => {
  it("removes maestro's env lines but preserves other lines", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, ".env"), "EXISTING=1\nOPENAI_BASE_URL=http://x/v1\nOPENAI_API_KEY=k\nOPENAI_MODEL=gpt-4o\n");
    const r = resetCodex("project", CODEX_ENV_KEYS, { cwd });
    const txt = readFileSync(join(cwd, ".env"), "utf8");
    expect(txt).toContain("EXISTING=1");          // preserved
    expect(txt).not.toContain("OPENAI_BASE_URL");
    expect(txt).not.toContain("OPENAI_API_KEY");
    expect(r.changed.sort()).toEqual([...CODEX_ENV_KEYS].sort());
  });
});
