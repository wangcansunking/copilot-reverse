# E2E results

Latest run of the end-to-end suite. Regenerate after every code change with `npm run test:e2e`
and update this file (paste the summary).

- **2026-06-26 (split antml: sentinel)** — Fixed a recurrence of the text-emitted-tool-call bug: the
  `ToolCallExtractor` split-sentinel hold-back (`PREFIX_TOKENS`) listed only the bare `<invoke` /
  `<function_calls>` forms — the two namespaced slots were duplicated bare copies. Copilot streams
  Claude's `antml:`-namespaced tool call token by token, so an opening `<invoke` is routinely split
  across chunks; the partial tail wasn't held back, leaked as text, and the remainder no longer
  matched the trigger — the whole call rendered as a literal `<invoke …>` block (seen live as a
  `TaskUpdate` printed instead of executed). Derive the namespaced variants from the bare tokens so
  both are held back; added split-at-every-offset regression tests. Affects both outbound paths
  (Anthropic + the new `/responses` SSE) since they share the extractor. Full suite green: `npm test`
  → **312 passed** (53 files), `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (Codex /responses)** — Fixed Codex startup: new Codex removed `wire_api = "chat"`
  (codex#7782) and requires `"responses"`, which makes it POST `{base_url}/responses`. Implemented the
  OpenAI Responses API at `POST /openai/responses` (new `src/core/responses-inbound.ts`: item-centric
  request → canonical, canonical → response object, and a stateful SSE emitter with `sequence_number`
  and the `response.created → output_item.added → content_part.added → output_text.delta → … →
  response.completed` event sequence). Codex config now writes `wire_api = "responses"` (base_url
  stays `…/openai`; Codex appends `/responses`). Verified live end-to-end against real Copilot:
  non-stream returns a completed `response` object with an `output_text` item; stream begins
  `response.created` and ends `response.completed` with `output_text.delta` in between. Full suite
  green: `npm test` → **294 passed** (52 files), `npm run test:e2e` → **31 passed**, tsc build clean.

- **2026-06-26** — Restored web_search / web_fetch for Claude Code through the gateway. The inbound
  translator now converts Anthropic's server-side web tools to function tools (instead of dropping
  them); a capped agentic loop in the Anthropic endpoint runs those tools internally against
  Microsoft Web IQ (`api.microsoft.ai`) and feeds results back, so the client only ever sees the
  final grounded answer (transparent). A new `/web-search-support` command stores the WebIQ key
  (data dir or `WEBIQ_API_KEY`, read lazily — no worker restart). Also added a startup status card
  (GitHub login state — connected/expired/signed-out, since the device-flow token has no real
  expiry — plus web search readiness, worker, and configured clients) and a live `web ✓/✗` indicator
  in the now two-line HUD footer. Verified live end-to-end (real Copilot + real WebIQ): a
  `web_search` request returned `stop_reason: end_turn` with a fresh answer and no tool_use block
  leaked to the client. Full suite green: `npm test` → **281 passed** (51 files), `npm run test:e2e`
  → **31 passed** (4 files), tsc build clean.

- **2026-06-25** — Fixed the `/login` deadlock: the slash command buffered the device code behind a
  blocking token poll, so the Repl showed nothing and the user could never authorize. Split device
  login into `beginDeviceLogin` (returns the code immediately) + `complete()` (polls), and gave the
  TUI a non-blocking `/login` branch that renders the verification URL + code first, then a
  completion card. Also hardened the failure path: auth errors (e.g. `incorrect_device_code`) render
  a clean error card instead of crashing the process, and a double Enter no longer starts two
  device-code flows. Added a pre-flight auth gate on chat: a signed-out or expired-login message is
  blocked immediately with a "run /login" hint instead of hanging until the 120s turn timeout. Full
  suite green: `npm test` → **242 passed** (47 files), `npm run test:e2e` → **31 passed** (4 files),
  tsc build clean.

- **2026-06-23** — Added `ToolCallExtractor` (recovers text-emitted `<function_calls>`/`<invoke>`
  tool calls into structured tool chunks) plus changeset-driven auto-release (build-time version
  injection, release workflow). Full suite green: `npm test` → **236 passed** (47 files), e2e all
  green, tsc build clean.

- **Date:** 2026-06-22 22:14 CST
- **Runner:** vitest 2.1.9 · Node v25.6.0
- **Command:** `npm run test:e2e`
- **Outcome:** ✅ 30 passed / 0 failed (4 files)

The main suite (`copilot-reverse.e2e.test.ts`) covers EP-01 … EP-26 — see [`cases.md`](./cases.md)
for the catalog. Plus the pre-existing smoke specs under `tests/e2e/` (m1-smoke ×2, m1a-smoke,
anthropic-mixed-stream).

```
Test Files  4 passed (4)
     Tests  30 passed (30)
```

## Full project suite

`npm test` (unit + integration + e2e): **215 passed**, tsc build clean.

## Live integration (opt-in)

`npm run test:integration` against the real Copilot API (local login required): **7 passed**
(token exchange, model discovery incl. 1M window, OpenAI completion, Anthropic streaming with
distinct answers, real message_delta usage, count_tokens). Auto-skips with no login.
