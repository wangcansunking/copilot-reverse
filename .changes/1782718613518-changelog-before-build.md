---
bump: patch
---
fix(release): update CHANGELOG before the build so the just-released version appears in `/changes`. gen-changes.mjs runs in prebuild and reads CHANGELOG, but the workflow appended the new entry only after publish — so each release's own notes lagged one version behind. CHANGELOG is now written before build; changesets are still consumed after publish.
