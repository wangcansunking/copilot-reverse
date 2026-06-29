# E2E results

Latest run of the end-to-end suite. Regenerate after every code change with `npm run test:e2e`
and update this file (paste the summary).

- **2026-06-29 (Docker e2e matrix + CI wiring)** — Added a third Docker e2e driver: a hermetic HTTP
  edge-case matrix (`e2e/docker/Dockerfile.http` + `http-e2e.mjs`) that boots the **real** worker +
  supervisor on a dummy token and drives them over HTTP — 15 checks covering proxy errors (malformed
  JSON→400, >20mb→413, 404, models/healthz/count_tokens), supervision lifecycle (status/doctor/
  requests/dashboard/restart-recovery), and a deterministic `EventBus` isolation guard that **fails on
  a reverted PR #8** (verified: 15/15 with the guard, 2 fail without). Extended `cli-e2e.sh` with codex
  multi-line, claude constrained-numeric, and a `[1m]` model-id round-trip (now 7 real-CLI checks, all
  pass with a token mounted). New CI `docker-e2e` job runs http-e2e hermetically every push and gates
  the real-CLI run on a `CR_GH_TOKEN` secret. Hermetic suite green: `npm test` → **406 passed**, build
  clean. (HTTP edge cases are quota-free; only the golden round-trips + cli-e2e need a real token.)

- **2026-06-29 (crash-guard hardening + code-review fixes)** — Guarded the synchronous throw sites
  that could kill the single-process TUI+supervisor app (a dead-socket SSE write inside `EventBus.emit`,
  a corrupt/locked `creds.json` read on the heartbeat tick), and added a process-level
  `unhandledRejection`/`uncaughtException` backstop that logs to `~/.copilot-reverse/crash.log` and keeps
  the TUI alive. A `/code-review` pass surfaced six follow-ups, all fixed: `CopilotTokenStore` now reads
  its GitHub token through a provider (a transient null can't poison the store for the session — it
  raises a clean 401 and recovers on the next read, instead of sending `authorization: token null`); the
  backstop uses a shared, size-capped/rotating crash logger and a 5-in-10s circuit breaker that exits for
  a clean restart on a storm; the heartbeat's defensive catch now logs instead of swallowing silently;
  the signed-out gate checks token-file existence (`hasGhTokenFile`) so a transient lock no longer reads
  as "signed out"; and the SSE route subscribes before the hello frame. Full suite green: `npm test` →
  **406 passed** (57 files), tsc build clean. Both Docker e2e suites pass against real services with a
  token (+ WebIQ key) mounted: heartbeat container (`e2e/docker/Dockerfile`) → **all 4 states passed**
  (connected/signed-out/expired/HTTP, real GitHub 401); real CLI container (`Dockerfile.cli`) →
  **4/4 passed** (`codex exec → /openai/responses → CODEX_OK`, `claude -p → /anthropic → CLAUDE_OK`,
  `claude` gateway web search → grounded "1.96.0", no tool leak) — confirming the worker's plain-string
  `CopilotTokenStore` path still works under the new union-typed constructor.

- **2026-06-28 (real CLI Docker e2e + 2 Codex bugs fixed)** — Added a true black-box e2e: the actual
  `claude` and `codex` CLIs run inside a `node:22` container against the real worker daemon
  (`e2e/docker/Dockerfile.cli` + `cli-e2e.sh`), with a real token (+ WebIQ key) mounted. All three
  checks pass: `codex exec → /openai/responses → CODEX_OK`, `claude -p → /anthropic → CLAUDE_OK`,
  and `claude` gateway web search → a grounded answer ("1.96.0"). The driver writes a markdown report
  after each run (`/out/report.md`). This path **caught two bugs nothing else did**: (1) Codex sends
  `custom`/`tool_search` tools that the inbound translator forwarded nameless → Copilot 400 "Missing
  required parameter: tools[N].name" → "stream closed before response.completed"; fixed by keeping
  `custom` tools as named tools and allow-listing only nameless hosted tools (`web_search`). (2) The
  `ResponsesSSE` terminal events carried empty text, so Codex completed the turn but rendered nothing;
  fixed by replaying the accumulated text in `output_text.done` / `content_part.done` /
  `output_item.done` and populating `response.completed.response.output`. Also added 12 hermetic
  in-process Codex `/responses` cases (EP-27…EP-38) as fast regression. No secrets are committed —
  the only key in any file is the placeholder `copilot-reverse-local`; real creds/keys mount at
  runtime and report artifacts are gitignored. Full suite green: `npm test` → **394 passed**
  (56 files), tsc build clean, real CLI Docker e2e → **all passed**.

- **2026-06-28 (GitHub-token heartbeat)** — Added a supervisor-side heartbeat that periodically (every
  60s, plus once ~2s after boot) checks whether the stored GitHub token still exchanges for a Copilot
  token, and surfaces the result via a new optional `github` field on `/api/status`. The TUI's existing
  2s status poll drives a live footer badge (`github ✓` / `✗ /login`), so an expired/revoked login
  shows within ~60s instead of only on the next failed request or a manual `/status`. Key design: a
  classifying `probeGithubAuth` distinguishes a definitive 401/403 (→ expired) from a transient
  timeout/5xx/network error (→ keep last-known-good), so a single GitHub hiccup never flips the badge;
  `nextGithubStatus` is a pure, sticky reducer. `signed-out` (no token) stays distinct from `expired`.
  New files: `src/supervisor/github-heartbeat.ts`, `tests/supervisor/github-heartbeat.test.ts`.
  **Real Linux container e2e** (`e2e/docker/`): a Docker image boots the real control API + a real
  `GithubHeartbeat.start()`, listens on a real port, and drives it over real HTTP (`GET /api/status`)
  against the real GitHub API — all four states pass, including `connected` (real token → real Copilot
  token exchange, mounted read-only) and `expired` (bad token → a real GitHub 401). Only the probe
  interval is shortened (now injectable) for the test. Full suite green: `npm test` → **378 passed**
  (56 files), `npm run test:e2e` → **31 passed** (4 files), container e2e → **all passed**, tsc build clean.

- **2026-06-26 (default to WebIQ; disable slow borrow)** — gpt-5-mini (the Claude "borrow" backend
  model) is badly congested on Copilot's `/responses`: repeated `503 "high demand"` and 20s–7min
  stalls measured live (one user search ran 437s). Same native search on gpt-5.4-mini/gpt-5.4/gpt-5.5
  is ~4s, and WebIQ is sub-second — so borrow is gated behind `COPILOT_WEB_SEARCH_ENABLED` (now
  `false`) and web search routes through WebIQ. `resolveWebSearchBackend(mode, hasKey)` →
  `copilot | webiq | unavailable` centralises the policy; the runner returns a fixed "run /webiq …"
  message (with the profile URL) when unavailable. Also: `borrowSearch` gained a 30s timeout (the
  missing one is why a stalled search hung the turn for minutes) and runs at `reasoning.effort:"low"`
  (~5-6x faster when it is used). status card + HUD show the resolved backend incl. unavailable.
  Codex's native `/responses` web_search is untouched. Verified live: Claude `web_search` routes
  through WebIQ end-to-end (`end_turn`, grounded Rust 1.96.0 answer, no tool_use leak); no-key path
  returns the `/webiq` guidance. Full suite green: `npm test` → **356 passed** (55 files),
  `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (Phase 2: web-search backends)** — Web search now works out of the box for both
  clients, with no key. **Claude path**: the gateway borrows gpt-5-mini's native web_search internally
  (`borrow-search.ts`), extracts url_citation sources, and feeds them back — verified live through the
  worker's `/anthropic/v1/messages` with a `web_search_20250305` tool: returned a fresh grounded answer
  (Rust 1.96.0), `stop_reason: end_turn`, and NO tool_use block leaked to the client. **Codex path**:
  the hosted `web_search` tool is passed through both `/responses` translators (new
  `CanonicalRequest.hostedTools`) so Copilot runs it server-side — verified live: gpt-5.5 returns
  output items `reasoning/web_search_call/message` with citations. **Backend routing**: gateway runner
  picks per call — default "copilot" borrow, or "webiq" (forced WebIQ) when enabled; mode persisted in
  webiq.json, read lazily (no restart). **Commands**: removed `/web-search-support`; added hidden
  `/webiq` + `/webiq clean`; status card + HUD show the active backend. Full suite green: `npm test` →
  **350 passed** (55 files), `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

- **2026-06-26 (outbound /responses routing)** — Newer Copilot models are served ONLY on /responses:
  live probe confirms `gpt-5.5` (and `gpt-5.3-codex`, `gpt-5.4-mini`, `mai-code-1-flash-internal`)
  report `supported_endpoints: ["/responses","ws:/responses"]` with no `/chat/completions`. Added the
  outbound translation module (`src/providers/copilot/responses-upstream.ts`), routed the adapter by
  `supported_endpoints` (with a `/chat` 400 `unsupported_api_for_model` → `/responses` retry net), and
  wired `fetchModelEndpoints` into the worker (lazy, same source as the model list). Verified live
  end-to-end against real Copilot: adapter `complete()`/`stream()` on gpt-5.5 hit /responses
  (`ROUTED_OK` / `STREAM_OK`); and through the worker over HTTP, `POST /openai/responses` non-stream
  returned `status: completed` + `output_text: E2E_RESPONSES_OK`, stream ran `response.created …
  response.completed`. gpt-4o still routes to /chat/completions. Full suite green: `npm test` →
  **329 passed** (54 files), `npm run test:e2e` → **31 passed** (4 files), tsc build clean.

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
