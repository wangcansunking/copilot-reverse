# Changesets

This folder drives **automatic versioning + npm publishing**. When a commit lands on `master`
with one or more changeset files here, the [`release` workflow](../.github/workflows/release.yml)
bumps the version, publishes to npm, tags the release, and deletes the spent changesets.

**No changeset = no release.** Plain `docs:` / `chore:` commits don't publish anything.

## Add a changeset

```bash
npm run changeset minor "namespaced worker routes"   # or: patch | major
```

…or just drop a file `.changes/anything.md`:

```markdown
---
bump: minor
---
Human-readable summary of the change. This line is prepended to CHANGELOG.md.
```

## Bump levels (standard semver, no 0.x special-casing)

| level   | 0.1.0 → | when |
|---------|---------|------|
| `patch` | 0.1.1   | bug fix, no API/route change |
| `minor` | 0.2.0   | new feature, additive |
| `major` | 1.0.0   | breaking change (e.g. route/CLI/config that requires user action) |

If several changesets are present in one release, the **highest** level wins.

## What the release does

1. reads the highest `bump:` across all changesets here
2. `npm version <bump>` → regenerates `src/version.ts`
3. `npm run build && npm test` (gate)
4. `npm publish` (idempotent — skipped if that version is already on npm)
5. consumes (deletes) these changeset files, prepends their bodies to `CHANGELOG.md`
6. commits `release: vX.Y.Z` + tags `vX.Y.Z`, pushes back to `master`

The release commit is pushed with the default `GITHUB_TOKEN`, so it does **not** re-trigger the
workflow — no publish loop.
