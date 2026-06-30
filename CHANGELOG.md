## v0.10.0 — 2026-06-30

feat(tui): the startup "what's new" banner now shows the real recent headlines (top 3 across recent releases, version-tagged) instead of a generic "type /changes" pointer — so a freshly shipped feature is actually visible on launch rather than the banner looking empty. `/changes` now lists every change in a bundled release: `gen-changes` captures all paragraphs of each release (not just the first), so a headline feature merged alongside a plumbing fix is no longer hidden. Each release renders as a header with one bullet per change.

## v0.9.0 — 2026-06-30

fix(release): update CHANGELOG before the build so the just-released version appears in `/changes`. gen-changes.mjs runs in prebuild and reads CHANGELOG, but the workflow appended the new entry only after publish — so each release's own notes lagged one version behind. CHANGELOG is now written before build; changesets are still consumed after publish.

feat(tui): `/metrics` now renders a styled card — a colored summary row (reqs · errors · tokens↑↓ · est. cost) over an aligned per-model table — instead of flat gray lines. Numbers carry accent/state colors, labels are dimmed, models sort by request count.

feat(network): explicit access modes — **localhost** (default, loopback only — private to this machine) vs **LAN** (`/network` to enable). LAN exposes the worker proxy on the network and requires a key on every request **from another machine** — `Authorization: Bearer <key>` or `x-api-key` — rejecting a remote request without it (`401`) before any upstream call. Your own machine keeps working over `127.0.0.1` with no key, so local Claude/Codex need no change when you flip to LAN (the local-vs-remote decision is TCP-layer only, never a spoofable header). It's **fail-closed**: enabling LAN auto-generates a key (no keyless LAN), and a remote request is refused (`503`) if a key ever goes missing — never an open relay. The key (timing-safe compare) is read per request, so rotation needs no restart; flipping the mode restarts the worker to rebind the socket. The supervisor control plane stays on localhost regardless. New `/network` panel, a `/config` row, and a `net` HUD indicator.

## v0.8.0 — 2026-06-29

Map Copilot model ids to the canonical ids Claude Code's native /model picker recognises, so models show friendly names and the 1M-context badge instead of bare ids. Outbound, `/anthropic/v1/models` dashes claude ids (`claude-opus-4.8` → `claude-opus-4-8[1m]`) and tags opus 4.6/4.7/4.8 + sonnet 4.6 as 1M; setup's default ANTHROPIC_MODEL is dashed the same way so the picker matches it; inbound, requests resolve back to the real Copilot model. GPT/o3 pass through unchanged.

## v0.7.0 — 2026-06-29

feat(tui): `/metrics` now reports token usage (in/out) and an estimated cost per model and overall — the worker records prompt/completion tokens for every request (persisted in SQLite), and cost is a list-price estimate (Copilot is flat-fee). User messages also get a highlighted bar in the transcript so they stand out from muted system notes and assistant output.

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

