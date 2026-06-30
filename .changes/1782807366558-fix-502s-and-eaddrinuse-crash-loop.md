---
bump: patch
---
fix(worker,supervisor): stop three recurring 502/crash failures behind `/doctor` and the daemon

- **EADDRINUSE crash loop → daemon "unhealthy"**: a forked worker no longer orphans when its
  supervisor dies abnormally (terminal closed/killed/crashed). The worker now exits on IPC
  `disconnect`, releasing `:7891` instead of squatting it so the next supervisor's worker can't
  bind. The supervisor's manual restart also waits for the old worker to fully exit before spawning
  the replacement, closing the kill/respawn race that hit the same `listen EADDRINUSE :7891`.
- **502 `Cannot read properties of undefined (reading 'message')`**: the Copilot adapter's non-stream
  `complete()` guards an empty `choices` array (a content-filtered turn or a 1-token ping) and
  returns an empty completion instead of throwing.
- **502 `Invalid 'max_output_tokens'` on responses-only models (e.g. gpt-5.5)**: `max_output_tokens`
  is clamped up to the Responses API minimum of 16, so `/doctor`'s 1-token ping (and Claude Code's
  connection probe) no longer 400s.

Docker HTTP e2e gains an EADDRINUSE regression block (orphaned worker releases its port when the IPC
parent drops; daemon stays `ready` through restart churn); new units cover the empty-choices guard,
the `max_output_tokens` floor, and the restart-waits-for-exit ordering.
