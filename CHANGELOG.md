## v0.3.0 — 2026-06-26

Restore `web_search` and `web_fetch` for Claude Code through the gateway: the worker now runs these tools internally against Microsoft Web IQ in a transparent agentic loop, and a new `/web-search-support` command stores the WebIQ API key.

## v0.2.1 — 2026-06-25

Fix `/login` hanging with no output: the device-code prompt is now shown immediately while authorization is pending, instead of being buffered behind the blocking token poll.

## v0.2.0 — 2026-06-23

Recover tool calls that some models emit as inline XML text into structured tool calls, and add changeset-driven automatic versioning + npm publish on merge to master.

