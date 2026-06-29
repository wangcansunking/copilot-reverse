---
bump: patch
---
ci: gate PRs on a changeset. A pull request with no file in `.changes/` now fails the `changeset` check, so merges can't silently skip the release (the v0.5.3 freeze). Docs/test-only PRs opt out with a `no-changeset` label.
