## v0.6.0 — 2026-06-29

feat(tui): add a `/changes` command listing the 10 most recent releases (version, date, summary) with a link to the full CHANGELOG, and refocus the startup "what's new" banner on important messages — it now points to `/changes` instead of advertising a bug fix, and still self-suppresses after 3 launches.

## v0.5.5 — 2026-06-29

ci: gate PRs on a changeset. A pull request with no file in `.changes/` now fails the `changeset` check, so merges can't silently skip the release (the v0.5.3 freeze). Docs/test-only PRs opt out with a `no-changeset` label.

## v0.5.4 — 2026-06-29

fix(worker): stop the empty-tool-call loop ("call: call: call:…") that froze sessions. Inline-XML blocks that recover no tool are now passed through verbatim instead of silently swallowed; nameless `function_call` items on the /responses path are dropped instead of streamed as a blank `call:`; and the runaway deadline now covers tool-call streams, not just text — a model looping on tool calls is cut cleanly instead of relaying forever.

## v0.5.3 — 2026-06-29

Fix inline tool-call XML (`<invoke name=…>`) leaking as literal text instead of running. The extractor that recovers these blocks only ran on the chat path when the request declared tools, and never on the Codex `/responses` path. It now runs always-on across both streaming and non-stream paths, so a follow-up turn or a `/responses` model can no longer dump raw XML into the reply.

## v0.5.2 — 2026-06-29

Fix the daemon going permanently dead during dogfooding. The worker had no `unhandledRejection` handler, so a stray floating rejection silently killed it (exit 1, empty stderr) on Node ≥15; once that happened 5×/60s the supervisor marked it `unhealthy` and gave up forever, leaving a running daemon with a dead worker. The worker now handles `unhandledRejection`, writes the cause to stderr *before* the IPC report (so crashes are no longer blind), the supervisor persists each crash to `crash.log`, and `unhealthy` now recovers: after a 30s cooldown it resets the window and tries again instead of staying down.

## v0.5.1 — 2026-06-28

Fix the app dropping back to the shell during concurrent use. The TUI and supervisor share one process, but several synchronous throw sites had no handler — most importantly an SSE write to a client socket that died between broadcasts (likely with multiple clients connected), which crashed the whole process. Each broadcast listener is now isolated and a dead SSE connection is dropped instead of retried; `readGhToken` returns null on a corrupt/locked read instead of throwing on the heartbeat tick; and a process-level backstop logs any remaining stray throw/rejection to `~/.copilot-reverse/crash.log` and keeps the TUI alive.

## v0.5.0 — 2026-06-28

Add a GitHub-token heartbeat: the supervisor now re-checks every ~60s whether the stored GitHub login still works, and the TUI footer shows a live `github ✓` / `✗ /login` badge — so an expired or revoked login surfaces within ~60s instead of only on the next failed request or a manual `/status`. A transient network/rate-limit hiccup is distinguished from a real auth failure, so the badge never flips on a single blip.

## v0.4.0 — 2026-06-26

Codex `/responses` support, web search via Microsoft Web IQ, and a tool-call recovery fix:

- **Codex**: implement the OpenAI Responses API (`POST /openai/responses`) so Codex (which dropped `wire_api="chat"`) connects. Responses-only models (gpt-5.5, gpt-5.3-codex, …) are auto-routed via each model's `supported_endpoints` with a `/chat` 400 fallback. Codex's native `web_search` runs server-side on Copilot with citations.
- **Web search**: routed through Microsoft Web IQ. Set the key with `/webiq` (get one at https://webiq.microsoft.ai/profiles/); `/webiq clean` clears it. With no key, the tools return a message pointing to `/webiq`. A keyless gpt-5-mini "borrow" backend exists behind a flag but is disabled by default (gpt-5-mini is currently congested on Copilot; Web IQ is sub-second). Status card + HUD show the active backend.
- **Fix**: recover tool calls whose `antml:`-namespaced `<invoke>` sentinel is split across stream chunks (previously leaked as literal text).

## v0.3.0 — 2026-06-26

Restore `web_search` and `web_fetch` for Claude Code through the gateway: the worker now runs these tools internally against Microsoft Web IQ in a transparent agentic loop, and a new `/web-search-support` command stores the WebIQ API key.

## v0.2.1 — 2026-06-25

Fix `/login` hanging with no output: the device-code prompt is now shown immediately while authorization is pending, instead of being buffered behind the blocking token poll.

## v0.2.0 — 2026-06-23

Recover tool calls that some models emit as inline XML text into structured tool calls, and add changeset-driven automatic versioning + npm publish on merge to master.

