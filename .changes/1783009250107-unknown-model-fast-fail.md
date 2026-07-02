---
bump: patch
---
fix(worker): fast-fail an unknown/typo'd model id instead of freezing the turn (#50 P1). An upstream 4xx (e.g. `model_not_supported`) was masked as a retriable 502/`api_error`, so clients that retry (Claude Code, the Anthropic SDK) backed off to their 90s turn timeout and froze. The worker now carries the upstream status through a typed `UpstreamError` and surfaces a permanent 4xx as a terminal `invalid_request_error` (HTTP 400 on the non-stream path; a terminal `error` SSE frame on the stream path), while genuine 5xx/network/429 stay retriable 502s — honoring the never-freeze north-star.
