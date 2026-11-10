---
'@kidlib/web-audio': minor
---

Add `SamplePlayer.disposed`; repeated disposal and late note calls are harmless, and loading or initializing after teardown rejects with `SamplePlayer is disposed`.
