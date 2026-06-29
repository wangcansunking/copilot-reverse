---
bump: minor
---
feat(network): explicit access modes — **localhost** (default, loopback only — private to this machine) vs **LAN** (`/network` to enable). LAN exposes the worker proxy on the network but requires a key on every request — `Authorization: Bearer <key>` or `x-api-key` — rejecting anything else with `401` before any upstream call. It's **fail-closed**: enabling LAN auto-generates a key (no keyless LAN), and the proxy refuses to serve (`503`) if a key ever goes missing — never an open relay. The key (timing-safe compare) is read per request, so rotation needs no restart; flipping the mode restarts the worker to rebind the socket. The supervisor control plane stays on localhost regardless. New `/network` panel, a `/config` row, and a `net` HUD indicator.
