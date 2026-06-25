# E2E results

Latest run of the end-to-end suite. Regenerate after every code change with `npm run test:e2e`
and update this file (paste the summary).

- **2026-06-25** — Fixed the `/login` deadlock: the slash command buffered the device code behind a
  blocking token poll, so the Repl showed nothing and the user could never authorize. Split device
  login into `beginDeviceLogin` (returns the code immediately) + `complete()` (polls), and gave the
  TUI a non-blocking `/login` branch that renders the verification URL + code first, then a
  completion card. Also hardened the failure path: auth errors (e.g. `incorrect_device_code`) render
  a clean error card instead of crashing the process, and a double Enter no longer starts two
  device-code flows. Full suite green: `npm test` → **240 passed** (47 files), `npm run test:e2e` →
  **31 passed** (4 files), tsc build clean.

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
