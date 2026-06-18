# E2E results

Latest run of the end-to-end suite. Regenerate after every code change with `npm run test:e2e`
and update this file (paste the summary).

- **Date:** 2026-06-18 08:23 UTC
- **Runner:** vitest 2.1.9 · Node v25.6.0
- **Command:** `npm run test:e2e`
- **Outcome:** ✅ 13 passed / 0 failed (4 files)

| ID | Scenario | Result |
|----|----------|--------|
| EP-01 | Anthropic streaming framing | ✅ pass |
| EP-02 | OpenAI completion | ✅ pass |
| EP-03 | count_tokens estimate | ✅ pass |
| EP-04 | server-side tool dropped (no hang) | ✅ pass |
| EP-05 | error frame + supervisor error capture | ✅ pass |
| EP-06 | dashboard served at `/` | ✅ pass |
| EP-07 | `/logs` shows request errors | ✅ pass |
| EP-08 | `/dashboard` + `/report` open URLs | ✅ pass |
| EP-09 | `/reset-claude` round-trip | ✅ pass |

Plus the pre-existing smoke specs under `tests/e2e/` (m1-smoke ×2, m1a-smoke, anthropic-mixed-stream) — all green.

```
Test Files  4 passed (4)
     Tests  13 passed (13)
```
