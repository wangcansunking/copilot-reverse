---
bump: patch
---
Fix inline tool-call XML (`<invoke name=…>`) leaking as literal text instead of running. The extractor that recovers these blocks only ran on the chat path when the request declared tools, and never on the Codex `/responses` path. It now runs always-on across both streaming and non-stream paths, so a follow-up turn or a `/responses` model can no longer dump raw XML into the reply.
