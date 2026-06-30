// REGRESSION GUARD (issue #35, closed wontfix) — count_tokens is backed by a char/4 estimate, not a
// real tokenizer. The probe that closed #35 established that Copilot normalizes prompt_tokens across
// gpt-4o AND Claude identically, and that char/4 lands within roughly [0.6, 1.4] of the upstream's
// exact count (under-counts short prompts ~27%, over-counts long prompts ~11% — the safe direction).
// We deliberately did NOT add a ~2MB tokenizer dep for that. This test stands guard: if our estimate
// ever drifts WILDLY from upstream truth (a broken estimator, or upstream changing accounting), it
// trips. Read-only; auto-skips with no login; runs only via `npm run test:integration`.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import { CopilotAdapter } from "../src/providers/copilot/adapter.js";
import { CopilotTokenStore, isCopilotTokenValid } from "../src/providers/copilot/token.js";
import { fetchCopilotModels } from "../src/providers/copilot/models.js";
import { estimateTokens } from "../src/core/tokens.js";
import { anthropicRequestToCanonical } from "../src/core/anthropic-inbound.js";
import { readGhToken } from "../src/shared/creds.js";
import { dataDir } from "../src/shared/paths.js";

const gh = readGhToken(dataDir());
const hasLogin = await (async () => {
  if (!gh) return false;
  try { return await isCopilotTokenValid(gh); } catch { return false; }
})();
const liveIt = it.skipIf(!hasLogin);
if (!hasLogin) console.warn("[probe #35] no usable login — skipping tokenizer probe");

function liveWorker() {
  const store = new CopilotTokenStore(gh!);
  return createWorkerApp(new Router([new CopilotAdapter(store)], { "*": "gpt-4o" }), () => {});
}

// Pull the real upstream prompt_tokens by sending a 1-token completion and reading usage.
async function upstreamPromptTokens(model: string, prompt: string): Promise<number | null> {
  const res = await request(liveWorker()).post("/openai/chat/completions")
    .send({ model, max_tokens: 1, messages: [{ role: "user", content: prompt }] });
  if (res.status !== 200) return null;
  return res.body.usage?.prompt_tokens ?? null;
}

// Our local estimate for the same single-user-message prompt.
function localEstimate(prompt: string): number {
  return estimateTokens(anthropicRequestToCanonical({
    model: "x", max_tokens: 1, messages: [{ role: "user", content: prompt }],
  } as any));
}

const SHORT = "How many tokens is this short prompt?";
const LONG = "The quick brown fox jumps over the lazy dog. ".repeat(60); // ~big, ~540 words

// Bounds the char/4 estimate is expected to hold vs the upstream's exact prompt_tokens. Wide enough
// to absorb the known short-prompt undercount (~0.73) and long-prompt overcount (~1.11) plus headroom,
// tight enough that a genuinely broken estimator (off by >2x in either direction) trips the guard.
const LO = 0.55, HI = 1.45;

describe("REGRESSION GUARD #35: char/4 estimate stays within sane bounds of upstream prompt_tokens", () => {
  liveIt("gpt-* estimate is within [0.55, 1.45] of upstream exact count (short + long)", async () => {
    for (const prompt of [SHORT, LONG]) {
      const up = await upstreamPromptTokens("gpt-4o", prompt);
      const est = localEstimate(prompt);
      const ratio = up ? (est / up) : NaN;
      // eslint-disable-next-line no-console
      console.log(`[guard gpt-4o] chars=${prompt.length} upstream=${up} estimate=${est} est/up=${ratio.toFixed(3)}`);
      expect(up).toBeGreaterThan(0);
      expect(ratio).toBeGreaterThan(LO);
      expect(ratio).toBeLessThan(HI);
    }
  }, 40_000);

  liveIt("a Claude model's estimate is within the same bounds (Copilot normalizes counts cross-family)", async () => {
    const ids = await fetchCopilotModels(await new CopilotTokenStore(gh!).get());
    const claude = ids.find((m) => m.includes("claude")) ?? "claude-sonnet-4-6";
    for (const prompt of [SHORT, LONG]) {
      const up = await upstreamPromptTokens(claude, prompt);
      const est = localEstimate(prompt);
      const ratio = up ? (est / up) : NaN;
      // eslint-disable-next-line no-console
      console.log(`[guard ${claude}] chars=${prompt.length} upstream=${up} estimate=${est} est/up=${ratio.toFixed(3)}`);
      expect(up).toBeGreaterThan(0);
      expect(ratio).toBeGreaterThan(LO);
      expect(ratio).toBeLessThan(HI);
    }
  }, 40_000);
});
