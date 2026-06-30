---
bump: minor
---
feat(tui): the startup "what's new" banner now shows the real recent headlines (top 3 across recent releases, version-tagged) instead of a generic "type /changes" pointer — so a freshly shipped feature is actually visible on launch rather than the banner looking empty. `/changes` now lists every change in a bundled release: `gen-changes` captures all paragraphs of each release (not just the first), so a headline feature merged alongside a plumbing fix is no longer hidden. Each release renders as a header with one bullet per change.
