---
bump: minor
---
Map Copilot model ids to the canonical ids Claude Code's native /model picker recognises, so models show friendly names and the 1M-context badge instead of bare ids. Outbound, `/anthropic/v1/models` dashes claude ids (`claude-opus-4.8` → `claude-opus-4-8[1m]`) and tags opus 4.6/4.7/4.8 + sonnet 4.6 as 1M; inbound, requests resolve back to the real Copilot model. GPT/o3 pass through unchanged.
