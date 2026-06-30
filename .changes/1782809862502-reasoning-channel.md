---
bump: minor
---
feat(reasoning): extended thinking + reasoning-effort passthrough. A `thinking`-enabled Anthropic request (or an OpenAI `reasoning_effort`) now drives the model's reasoning, and the chain-of-thought streams back as a native Anthropic thinking block (thinking_delta + signature_delta) ahead of the answer — so Claude Code renders its thinking panel through the proxy. The signed continuation token (reasoning_opaque) round-trips across tool-call turns to preserve reasoning context. Effort is also forwarded on the /responses path for gpt-5 models. Verified end-to-end against live Copilot.
