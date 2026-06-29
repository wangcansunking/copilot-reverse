---
bump: patch
---
fix(worker): stop the empty-tool-call loop ("call: call: call:…") that froze sessions. Inline-XML blocks that recover no tool are now passed through verbatim instead of silently swallowed; nameless `function_call` items on the /responses path are dropped instead of streamed as a blank `call:`; and the runaway deadline now covers tool-call streams, not just text — a model looping on tool calls is cut cleanly instead of relaying forever.
