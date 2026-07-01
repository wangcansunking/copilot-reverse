---
bump: minor
---
Downscale oversized images before they reach Copilot, fixing `model_max_prompt_tokens_exceeded` (a 502 relayed to the client) when a large image is in play. Copilot's `/chat` has no vision tiler for Claude models — it bills an inline `data:...;base64,...` URL as plain text at ~char/4, so a single full-resolution image (~9MB base64 ≈ 2.3M tokens) overflows the model's prompt limit. The worker now takes over the job the real Anthropic backend does for us: decode → downscale to a 1568px long edge → re-encode as JPEG, collapsing the payload ~6x before send.

Crucially this covers images returned **inside a `tool_result`** (a Bash command or MCP tool that emits a screenshot) — the real-world trigger, where the image was previously flattened into the tool result's text string and so bypassed both resize and token counting entirely. `tool_result` now carries structured images end-to-end: preserved on the Anthropic/OpenAI inbound paths, downscaled + counted, and forwarded inline on the Copilot `tool` message (which Copilot accepts — probed). The Responses path, whose `function_call_output` can't carry an image, notes the omission instead of shipping raw base64.

Runs on every image path (`/anthropic/v1/messages`, `/openai/chat/completions`, `/openai/responses`) and in `count_tokens`, so Claude Code's context sizing and the actual request agree. `estimateTokens` also now counts image bytes at all (top-level and inside tool results); it previously ignored images, under-reporting by millions and letting the client ship an oversized prompt straight into the 502.
