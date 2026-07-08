---
bump: minor
---
feat(status): show the logged-in GitHub user and Copilot plan on the status card. The GitHub line now reads e.g. `✓ connected · Can Wang (canwa_microsoft) · Copilot Enterprise` — the username comes from GitHub `/user`, and the plan (derived from the `sku` on the Copilot token exchange we already perform, so no extra request) is mapped to a friendly label. Both are best-effort: a failed or pending lookup, an expired login, or a signed-out state simply omits them.
