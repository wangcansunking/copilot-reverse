---
bump: patch
---
Fix the daemon going permanently dead during dogfooding. The worker had no `unhandledRejection` handler, so a stray floating rejection silently killed it (exit 1, empty stderr) on Node ≥15; once that happened 5×/60s the supervisor marked it `unhealthy` and gave up forever, leaving a running daemon with a dead worker. The worker now handles `unhandledRejection`, writes the cause to stderr *before* the IPC report (so crashes are no longer blind), the supervisor persists each crash to `crash.log`, and `unhealthy` now recovers: after a 30s cooldown it resets the window and tries again instead of staying down.
