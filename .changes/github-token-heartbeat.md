---
bump: minor
---
Add a GitHub-token heartbeat: the supervisor now re-checks every ~60s whether the stored GitHub login still works, and the TUI footer shows a live `github ✓` / `✗ /login` badge — so an expired or revoked login surfaces within ~60s instead of only on the next failed request or a manual `/status`. A transient network/rate-limit hiccup is distinguished from a real auth failure, so the badge never flips on a single blip.
