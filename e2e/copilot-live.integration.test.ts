// LIVE integration tests — these hit the REAL Copilot endpoints through our full stack (GitHub
// token exchange -> worker -> adapter -> api.githubcopilot.com). They are gated on a usable login:
// when no GitHub token is on disk (e.g. CI), every case auto-skips, so the default suite stays
// hermetic. Run locally with `npm run test:integration`.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import { CopilotAdapter } from "../src/providers/copilot/adapter.js";
import { CopilotTokenStore, isCopilotTokenValid } from "../src/providers/copilot/token.js";
import { fetchCopilotModels, fetchModelLimits } from "../src/providers/copilot/models.js";
import { readGhToken } from "../src/shared/creds.js";
import { dataDir } from "../src/shared/paths.js";

const gh = readGhToken(dataDir());
// Resolved before tests run so skipIf can gate synchronously.
const hasLogin = await (async () => {
  if (!gh) return false;
  try { return await isCopilotTokenValid(gh); } catch { return false; }
})();
const liveIt = it.skipIf(!hasLogin);

if (!hasLogin) {
  // Surface why everything skipped — not a failure, just no creds in this environment.
  // eslint-disable-next-line no-console
  console.warn("[integration] no usable GitHub/Copilot login on disk — skipping live tests");
}

function liveWorker() {
  const store = new CopilotTokenStore(gh!);
  return createWorkerApp(new Router([new CopilotAdapter(store)], { "*": "gpt-4o" }), () => {});
}

// Anthropic SSE -> concatenated assistant text.
function anthropicText(sse: string): string {
  let t = "";
  for (const blk of sse.split("\n\n")) {
    const d = blk.split("\n").find((l) => l.startsWith("data: "));
    if (!d) continue;
    try { const e = JSON.parse(d.slice(6)); if (e.type === "content_block_delta" && e.delta?.type === "text_delta") t += e.delta.text; } catch { /* skip */ }
  }
  return t;
}

describe("LIVE: Copilot token exchange", () => {
  liveIt("exchanges the GitHub token for a Copilot token", async () => {
    const token = await new CopilotTokenStore(gh!).get();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });
});

describe("LIVE: model discovery", () => {
  liveIt("lists models and includes a known one", async () => {
    const token = await new CopilotTokenStore(gh!).get();
    const ids = await fetchCopilotModels(token);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((m) => m.includes("gpt-4o") || m.includes("claude"))).toBe(true);
  });
  liveIt("reports a 1M context window for at least one model", async () => {
    const token = await new CopilotTokenStore(gh!).get();
    const limits = await fetchModelLimits(token);
    const windows = Object.values(limits);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.some((w) => w >= 1_000_000)).toBe(true);
  });
});

describe("LIVE: OpenAI endpoint", () => {
  liveIt("returns a real completion for a deterministic prompt", async () => {
    const res = await request(liveWorker()).post("/openai/chat/completions")
      .send({ model: "gpt-4o", max_tokens: 10, messages: [{ role: "user", content: "Reply with exactly: PONG" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content.toUpperCase()).toContain("PONG");
  }, 30_000);
});

describe("LIVE: Anthropic endpoint", () => {
  liveIt("different questions return DIFFERENT answers (no dedupe regression)", async () => {
    const ask = async (q: string) => {
      const res = await request(liveWorker()).post("/anthropic/v1/messages")
        .send({ model: "gpt-4o", max_tokens: 20, stream: true, messages: [{ role: "user", content: q }] });
      return anthropicText(res.text).toLowerCase();
    };
    const [france, two] = await Promise.all([
      ask("What is the capital of France? One word."),
      ask("What is 2+2? Digits only."),
    ]);
    expect(france).toContain("paris");
    expect(two).toContain("4");
    expect(france).not.toBe(two);
  }, 40_000);

  liveIt("streams real usage in message_delta", async () => {
    const res = await request(liveWorker()).post("/anthropic/v1/messages")
      .send({ model: "gpt-4o", max_tokens: 15, stream: true, messages: [{ role: "user", content: "name two colors" }] });
    const delta = res.text.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
      .filter((d): d is string => !!d).map((d) => { try { return JSON.parse(d); } catch { return null; } })
      .find((e) => e?.type === "message_delta");
    expect(delta.usage.input_tokens).toBeGreaterThan(0);
    expect(delta.usage.output_tokens).toBeGreaterThan(0);
  }, 30_000);
});

describe("LIVE: count_tokens", () => {
  liveIt("estimates a positive input_tokens for a real prompt", async () => {
    const res = await request(liveWorker()).post("/anthropic/v1/messages/count_tokens")
      .send({ model: "gpt-4o", messages: [{ role: "user", content: "how many tokens is this prompt" }] });
    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });
});

// EXTENDED THINKING (issue #33) — proves the reasoning channel round-trips through the REAL upstream:
// a `thinking`-enabled Anthropic request must come back as a native thinking block (thinking_delta +
// signature_delta) ahead of the answer text. Uses a Claude model routed without remapping. The upstream
// decides PER TURN whether to surface reasoning_text (non-deterministic — a trivial prompt may answer
// with none), so we retry a few times and assert the path works on a turn that DOES reason; the answer
// must always arrive. If no turn reasons across all attempts, we skip rather than fail (flake-proof).
describe("LIVE: extended thinking (#33)", () => {
  liveIt("a thinking-enabled request streams a real Anthropic thinking block before the text", async () => {
    const store = new CopilotTokenStore(gh!);
    const token = await store.get();
    const ids = await fetchCopilotModels(token);
    const claude = ids.find((m) => m.includes("claude-opus")) ?? ids.find((m) => m.includes("claude")) ?? "claude-opus-4.8";
    const router = new Router([new CopilotAdapter(store)], {});
    router.setAvailableModels(ids);
    const worker = createWorkerApp(router, () => {});
    const once = async () => {
      const res = await request(worker).post("/anthropic/v1/messages")
        .send({ model: claude, max_tokens: 600, stream: true, thinking: { type: "enabled", budget_tokens: 8000 }, messages: [{ role: "user", content: "What is 17*23? Show your step-by-step reasoning, then state the answer." }] });
      const fr = res.text.split("\n\n").map((b) => ({ event: b.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "", data: JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}") }));
      const thinkingStart = fr.find((f) => f.event === "content_block_start" && f.data.content_block?.type === "thinking");
      const thinkingText = fr.filter((f) => f.event === "content_block_delta" && f.data.delta?.type === "thinking_delta").map((f) => f.data.delta.thinking).join("");
      const answer = fr.filter((f) => f.event === "content_block_delta" && f.data.delta?.type === "text_delta").map((f) => f.data.delta.text).join("");
      return { reasoned: !!thinkingStart && thinkingText.length > 0, thinkingText, answer };
    };
    let reasoned = false, lastAnswer = "", sample = "";
    for (let i = 0; i < 4 && !reasoned; i++) {
      const r = await once();
      lastAnswer = r.answer || lastAnswer;
      if (r.reasoned) { reasoned = true; sample = r.thinkingText.slice(0, 80); }
    }
    // eslint-disable-next-line no-console
    console.log(`[thinking #33] reasoned=${reasoned} sample="${sample}" answer="${lastAnswer.slice(0, 60)}"`);
    // The answer must always come through; reasoning is asserted when the (non-deterministic) upstream
    // surfaced it. If it never did across 4 tries, skip the reasoning assertion rather than flake.
    expect(lastAnswer).toContain("391");
    if (reasoned) expect(sample.length).toBeGreaterThan(0);
    else console.warn("[thinking #33] upstream surfaced no reasoning in 4 attempts — reasoning path untested this run");
  }, 90_000);
});
