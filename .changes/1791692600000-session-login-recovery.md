---
bump: patch
---
Fix first-time GHE login by releasing the provider/hostname readline prompt before GitHub CLI inherits stdin. Stop connected, successful numeric-only Edit loops before forwarding another Claude request, without sharing state between sessions. Preserve upstream input limits separately from headline context windows for compaction setup, and expose context-overflow wording recognized by Claude Code so reactive compaction can recover instead of failing as an unknown API error.
