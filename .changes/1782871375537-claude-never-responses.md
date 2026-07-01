---
bump: patch
---
fix(worker): never route a Claude model to Copilot's Responses API. A large Claude turn (e.g. pasted history + an image) could hit a `/chat` 400 whose body matched the responses-only hint regex (`does not support …`), tripping the safety net into retrying on `/responses` — which rejects every Claude id with the confusing "model claude-opus-4.8 does not support Responses API", masking the real `/chat` error. Claude ids are now excluded from both the endpoint-map route and the 400 safety net, so the true `/chat` failure surfaces instead.
