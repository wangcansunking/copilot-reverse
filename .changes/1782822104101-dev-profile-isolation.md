---
bump: minor
---
feat(dev): isolated `dev` profile so `npm run dev` no longer collides with an installed prod instance. A profile gets its own ports (dev → 7990/7991) and its own data dir (`~/.copilot-reverse-dev`), selected by `COPILOT_REVERSE_PROFILE` (default profile is byte-identical to before). On first boot a non-default profile is seeded once from prod — the GitHub token and WebIQ/access keys carry over so you don't re-`/login` — while the LAN posture resets to localhost and `clients.json`/the metrics db are deliberately not copied (they point at the prod ports). The TUI header shows a `[dev]` chip so an isolated instance is never mistaken for prod. Ports stay overridable via `SUPERVISOR_PORT`/`WORKER_PORT` and the dir via `COPILOT_REVERSE_DATA_DIR`.
