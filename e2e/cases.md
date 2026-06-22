# E2E test cases

End-to-end scenarios that wire the **real** worker + supervisor + TUI modules together the way
the daemon does (worker metric sink → supervisor SQLite → control API), using a fake Copilot
provider so no live network/token is needed. Spec: [`copilot-reverse.e2e.test.ts`](./copilot-reverse.e2e.test.ts).

**Policy: every code update must keep all e2e cases green.** Run with `npm run test:e2e`
(`npm test` also runs them — the suite is included in the default vitest run).

| ID | Scenario | Expected result |
|----|----------|-----------------|
| EP-01 | Anthropic `POST /v1/messages` with `stream: true` | SSE contains `message_start`, a `text` delta, and `message_stop` |
| EP-02 | OpenAI `POST /v1/chat/completions` | `choices[0].message.content` is the assistant text |
| EP-03 | `POST /v1/messages/count_tokens` | `200` with `input_tokens > 0` (lets clients time auto-compaction) |
| EP-04 | `/v1/messages` carrying an Anthropic **server-side tool** (`web_search_20250305`) | request completes `200` — the built-in tool is dropped, so the client never hangs waiting for a `tool_result` |
| EP-05 | A failing provider stream | worker emits `event: error` (not a silent close) **and** the supervisor records the failure with its message, visible at `GET /api/requests` / dashboard |
| EP-06 | `GET /` on the supervisor | `200` HTML dashboard page |
| EP-07 | `/logs` slash command | lists recent request errors with their messages |
| EP-08 | `/dashboard` and `/report` slash commands | open the dashboard URL and a prefilled GitHub issue URL in the browser |
| EP-09 | `/reset-claude` after `setup` wrote config | removes exactly the `ANTHROPIC_*` keys copilot-reverse added, preserving the rest |
| EP-10 | two concurrent Anthropic streams | each `message_start` carries a UNIQUE message id (no dedupe-to-first) |
| EP-11 | Anthropic stream | `message_start` seeds a non-zero `input_tokens` estimate (context bar not stuck at 0%) |
| EP-12 | provider returns usage | `message_delta` reports `input_tokens` (prompt − cached), `output_tokens`, `cache_read_input_tokens` |
| EP-13 | OpenAI stream with usage | a usage chunk with `total_tokens` is emitted before `[DONE]` |
| EP-14 | OpenAI stream fails mid-flight | an `error` chunk is emitted, not a silent close |
| EP-15 | dated Anthropic id (`claude-opus-4-8-20251101`) | fuzzy-matched to the available Copilot model |
| EP-16 | `claude-opus-4.8[1m]` request | the `[1m]` suffix is stripped before forwarding |
| EP-17 | Anthropic image block | round-trips through the proxy as image content (vision) |
| EP-18 | mixed text+tool stream | text@0, tool@1, `stop_reason=tool_use` |
| EP-19 | non-stream tool_use response | maps to Anthropic `tool_use` content |
| EP-20 | OpenAI assistant tool_call + tool result | both reach the provider as canonical blocks |
| EP-21 | failed request | error message persists in `request_log`, queryable via `/api/requests` |
| EP-22 | control API | exposes status, doctor, requests endpoints |
| EP-23 | fresh db | round-trips a recorded request (migration-safe schema) |
| EP-24 | `setup-claude` global | HUD status reports configured (user scope); `[1m]` + window written |
| EP-25 | `setup-codex` | writes native `~/.codex/config.toml` with `model_context_window` |
| EP-26 | reset after 1M setup | removes every key including the 1M-window keys |

## What each case protects (regressions it would catch)

- **EP-01/EP-02** — core proxy translation (OpenAI/Anthropic ⇄ Copilot canonical), streaming framing.
- **EP-03** — the count_tokens endpoint Claude Code relies on; missing → 404 → compaction mis-times.
- **EP-04** — the "infinite hang on server-side tools" class of bug (agent-maestro #163/#150).
- **EP-05** — the headline fixes: no silent stream-close, and request-error capture end-to-end.
- **EP-06** — dashboard route stays mounted.
- **EP-10/EP-11/EP-12/EP-13** — the usage/id fixes: unique message id (different asks → different answers), non-zero context bar, real token usage.
- **EP-15/EP-16** — model resolution (fuzzy match + 1M `[1m]` suffix).
- **EP-17** — vision passthrough (images not dropped).
- **EP-18/EP-19/EP-20** — tool-call translation in both directions.
- **EP-24/EP-25/EP-26** — the full setup→status→reset lifecycle for both clients.
- **EP-07/EP-08/EP-09** — TUI command wiring: logs/error visibility, dashboard/report, config reset.
