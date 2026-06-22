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

## What each case protects (regressions it would catch)

- **EP-01/EP-02** — core proxy translation (OpenAI/Anthropic ⇄ Copilot canonical), streaming framing.
- **EP-03** — the count_tokens endpoint Claude Code relies on; missing → 404 → compaction mis-times.
- **EP-04** — the "infinite hang on server-side tools" class of bug (agent-maestro #163/#150).
- **EP-05** — the headline fixes: no silent stream-close, and request-error capture end-to-end.
- **EP-06** — dashboard route stays mounted.
- **EP-07/EP-08/EP-09** — TUI command wiring: logs/error visibility, dashboard/report, config reset.
