---
bump: minor
---
Model picker: drive the 1M-context `[1m]` badge from each model's real upstream context window instead of a hardcoded id set, and generalise the friendly-name mapping to any Claude family + single- or two-segment version. Fixes `claude-sonnet-5` (was showing as a bare id with no 1M badge despite being a 1M model upstream) and makes any future 1M model render correctly with zero code changes. Inbound resolution and non-1M models (Opus/Sonnet/Haiku 4.5 at 200K) are unaffected.
