// E2E: multi-turn conversation continuity. The Anthropic/OpenAI wire is STATELESS — the client (Claude
// Code on `--resume`, or an interactive REPL) replays the ENTIRE prior conversation in `messages` on
// every turn. So the only thing that makes a follow-up turn "remember" the first is the proxy faithfully
// forwarding that replayed history to Copilot. These cases capture what actually reached the provider on
// turn 2 and assert the turn-1 exchange survived the translation layer — the deterministic core of what
// the real-CLI `--resume` fidelity case proves against live Copilot (see docker/cli-e2e.sh).
// Case catalog: cases.md. Shared harness: helpers.ts.
import { describe, it, expect } from "vitest";
import request from "supertest";
import { wired } from "./helpers.js";
import type { ProviderAdapter } from "../src/providers/types.js";

describe("E2E: multi-turn continuity", () => {
  // Capture the CanonicalRequest.messages the provider is handed, so we can assert on the replayed
  // history rather than the model's (non-deterministic) answer.
  function capturingProvider() {
    let seen: any[] | undefined;
    const adapter: ProviderAdapter = {
      name: "copilot",
      complete: async (req) => { seen = req.messages; return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; },
      async *stream(req) { seen = req.messages; yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
    };
    return { adapter, seen: () => seen };
  }
  const textOf = (msgs: any[], role: string) =>
    msgs.filter((m) => m.role === role).flatMap((m) => m.content).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");

  it("EP-39 Anthropic turn 2 replays the full turn-1 exchange to the provider (--resume history round-trip)", async () => {
    const { adapter, seen } = capturingProvider();
    const { worker } = wired(adapter);
    // The body Claude Code sends on turn 2 of a resumed session: prior user + prior assistant, then the
    // new user turn. If the proxy dropped history, a follow-up like "what did I say?" could never work.
    await request(worker).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50,
      messages: [
        { role: "user", content: "the codeword is HORIZON" },
        { role: "assistant", content: [{ type: "text", text: "Got it, I'll remember HORIZON." }] },
        { role: "user", content: "what was the codeword?" },
      ],
    });
    const msgs = seen()!;
    // All three turns must reach the provider, in order, with content intact.
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
    expect(textOf(msgs, "user")).toContain("HORIZON");        // the fact stated in turn 1
    expect(textOf(msgs, "assistant")).toContain("HORIZON");   // the assistant's turn-1 reply, not dropped
    expect(textOf(msgs, "user")).toContain("what was the codeword?"); // the new turn
  });

  it("EP-40 OpenAI chat turn 2 replays the full turn-1 exchange to the provider", async () => {
    const { adapter, seen } = capturingProvider();
    const { worker } = wired(adapter);
    await request(worker).post("/openai/chat/completions").send({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "the codeword is HORIZON" },
        { role: "assistant", content: "Got it, I'll remember HORIZON." },
        { role: "user", content: "what was the codeword?" },
      ],
    });
    const msgs = seen()!;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
    expect(textOf(msgs, "assistant")).toContain("HORIZON");
    expect(textOf(msgs, "user")).toContain("what was the codeword?");
  });

  it("EP-41 streaming turn 2 also carries prior history (interactive REPL path is the same wire)", async () => {
    const { adapter, seen } = capturingProvider();
    const { worker } = wired(adapter);
    await request(worker).post("/anthropic/v1/messages").send({
      model: "claude-opus-4-8", max_tokens: 50, stream: true,
      messages: [
        { role: "user", content: "the codeword is HORIZON" },
        { role: "assistant", content: [{ type: "text", text: "Noted: HORIZON." }] },
        { role: "user", content: "repeat it" },
      ],
    });
    expect(textOf(seen()!, "user")).toContain("HORIZON");
    expect(textOf(seen()!, "assistant")).toContain("HORIZON");
  });
});
