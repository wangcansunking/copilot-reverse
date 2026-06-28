---
bump: patch
---
Fix the app dropping back to the shell during concurrent use. The TUI and supervisor share one process, but several synchronous throw sites had no handler — most importantly an SSE write to a client socket that died between broadcasts (likely with multiple clients connected), which crashed the whole process. Each broadcast listener is now isolated and a dead SSE connection is dropped instead of retried; `readGhToken` returns null on a corrupt/locked read instead of throwing on the heartbeat tick; and a process-level backstop logs any remaining stray throw/rejection to `~/.copilot-reverse/crash.log` and keeps the TUI alive.
