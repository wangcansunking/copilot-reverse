---
bump: minor
---
Codex `/responses` support, web search via Microsoft Web IQ, and a tool-call recovery fix:

- **Codex**: implement the OpenAI Responses API (`POST /openai/responses`) so Codex (which dropped `wire_api="chat"`) connects. Responses-only models (gpt-5.5, gpt-5.3-codex, …) are auto-routed via each model's `supported_endpoints` with a `/chat` 400 fallback. Codex's native `web_search` runs server-side on Copilot with citations.
- **Web search**: routed through Microsoft Web IQ. Set the key with `/webiq` (get one at https://webiq.microsoft.ai/profiles/); `/webiq clean` clears it. With no key, the tools return a message pointing to `/webiq`. A keyless gpt-5-mini "borrow" backend exists behind a flag but is disabled by default (gpt-5-mini is currently congested on Copilot; Web IQ is sub-second). Status card + HUD show the active backend.
- **Fix**: recover tool calls whose `antml:`-namespaced `<invoke>` sentinel is split across stream chunks (previously leaked as literal text).
