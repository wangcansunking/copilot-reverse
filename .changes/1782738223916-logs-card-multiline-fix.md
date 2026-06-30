---
bump: patch
---
fix(tui): `/logs` and `/metrics` no longer shatter their bordered card when an upstream error carries newlines (a Copilot 502 returns a whole HTML page). Errors are flattened to a single line at the source (`errorDetail`) and again where the commands render them, and `OutputCard` now splits any multiline content into separate rows as a final backstop.
