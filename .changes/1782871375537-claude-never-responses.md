---
bump: patch
---
fix(worker): only route to Copilot's Responses API when a model advertises it, and only send `reasoning_effort` to models that support it.

Two related upstream-routing bugs, both surfaced by the real-CLI e2e:

1. **Responses mis-routing.** A `/chat` 400 whose body matched the responses-only hint regex (`does not support …`, `invalid_request_body`) tripped the safety net into retrying on `/responses` — which is gpt-5-class only. For a Claude *or* gpt-4o turn that retry then 400'd ("model X does not support / is not supported via Responses API"), masking the real `/chat` error. The `/responses` route (primary and both 400 safety nets) is now gated on the live endpoint map positively listing `/responses` for the model, so only gpt-5.x / mai-code ever go there; every other model surfaces its true `/chat` failure.

2. **`reasoning_effort` sent to models that reject it.** `claude -p` defaults to gpt-4o and sends `effort=high`, but gpt-4o doesn't advertise `reasoning_effort` → every turn 400'd (`invalid_reasoning_effort`) — previously hidden behind bug 1. The adapter now gates the `/chat` `reasoning_effort` field on the model's advertised capability (from `/models`), defaulting to "send" only until discovery resolves so a supported model's reasoning turn is never silently dropped.
