import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexToml, codexTomlPath } from "../../src/tui/setup/codex-toml.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codex-"));

describe("applyCodexToml", () => {
  it("writes a fresh config.toml with model, provider, and context window", () => {
    const home = tmp();
    const r = applyCodexToml({ home, baseUrl: "http://127.0.0.1:7891/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    expect(r.path).toBe(codexTomlPath(home));
    const toml = readFileSync(r.path, "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain('model_provider = "copilot-reverse"');
    expect(toml).toContain("model_context_window = 1050000");
    expect(toml).toContain("[model_providers.copilot-reverse]");
    expect(toml).toContain('base_url = "http://127.0.0.1:7891/v1"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("preserves unrelated existing keys and is idempotent", () => {
    const home = tmp();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexTomlPath(home), 'approval_policy = "on-request"\nmodel = "old-model"\n');
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7891/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    const once = readFileSync(codexTomlPath(home), "utf8");
    expect(once).toContain('approval_policy = "on-request"'); // unrelated key preserved
    expect(once).toContain('model = "gpt-5.5"');               // replaced, not duplicated
    expect(once.match(/^model = /gm)?.length).toBe(1);
    // running again yields the same file (idempotent)
    applyCodexToml({ home, baseUrl: "http://127.0.0.1:7891/v1", model: "gpt-5.5", contextWindow: 1_050_000 });
    expect(readFileSync(codexTomlPath(home), "utf8")).toBe(once);
  });

  it("omits the context window when unknown", () => {
    const home = tmp();
    applyCodexToml({ home, baseUrl: "http://x/v1", model: "gpt-4o" });
    expect(readFileSync(codexTomlPath(home), "utf8")).not.toContain("model_context_window");
  });
});
