# Linux container e2e — GitHub-token heartbeat

A real end-to-end test of the GitHub-token heartbeat, run inside a Linux container so it can exercise
the full HTTP path against the real GitHub API. The Windows host can't easily do this (port 7890 is
held by a running instance, and native-module / path quirks get in the way); the container has its own
network namespace and a Linux toolchain.

**What's real here:** the actual `createControlApp` control API, a real `GithubHeartbeat` started via
its real `start()`/`stop()`, a real TCP listener, real `fetch()` calls to GitHub's Copilot-token
endpoint, and real HTTP polling of `GET /api/status`. Only the probe interval is shortened (1.5s vs the
production 60s) so state transitions are observable in seconds. See [`heartbeat-e2e.mjs`](heartbeat-e2e.mjs).

## What it asserts

| State | How it's produced | Expected `github` |
|-------|-------------------|-------------------|
| connected   | a real token (mounted) is exchanged for a real Copilot token | `ok:true, hasToken:true, detail:"token valid"` |
| signed-out  | creds file removed | `ok:false, hasToken:false`, detail mentions `/login` |
| expired     | a bad token → a **real GitHub 401** | `ok:false, hasToken:true`, detail mentions expired/login |
| HTTP        | real `GET /api/status` | JSON carrying `workerState` + `github` |

The `connected` case is skipped (not failed) if no token is mounted.

## Run it

From the repo root:

```bash
docker build -f e2e/docker/Dockerfile -t copilot-reverse-e2e .

# Without a real token (connected case skipped):
docker run --rm copilot-reverse-e2e

# With your real token mounted read-only (all four cases):
#   Linux/macOS:
docker run --rm -v "$HOME/.copilot-reverse/creds.json:/run/secrets/creds.json:ro" copilot-reverse-e2e
#   Windows (Git Bash) — disable path conversion and use a native path:
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "C:/Users/<you>/.copilot-reverse/creds.json:/run/secrets/creds.json:ro" \
  copilot-reverse-e2e
```

The token is mounted read-only at `/run/secrets/creds.json`; the driver copies it into a writable work
dir (`/tmp/cr-e2e`) so the signed-out / expired cases can rewrite creds without touching the mount.
Override the source path with `-e TOKEN_FILE=/some/path`.

Exit code `0` = all asserted states observed; non-zero = a failure (the failing check is printed).
