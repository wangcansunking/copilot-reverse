---
bump: patch
---
fix(tui): the "what's new" banner now shows **one line per recent version**, each surfacing that version's main change — instead of flattening all changes from the newest version (which let a single bundled release fill every slot). For a version that bundled several changesets it picks the headline change (a `feat`/`perf`, or hand-written prose, over a `fix`/`chore`; ties broken by length), so e.g. v0.9.0 shows the network access-modes feature rather than the release-plumbing fix.
