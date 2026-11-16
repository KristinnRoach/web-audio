---
'@kidlib/web-audio': patch
---

Internal restructuring: `SamplePlayer` now keeps its voices' state itself, and each voice's main-thread code is reduced to its effect chain. Sound and public API are unchanged.
