---
bump: minor
---
feat(tui): `/metrics` now reports token usage (in/out) and an estimated cost per model and overall — the worker records prompt/completion tokens for every request (persisted in SQLite), and cost is a list-price estimate (Copilot is flat-fee). User messages also get a highlighted bar in the transcript so they stand out from muted system notes and assistant output.
