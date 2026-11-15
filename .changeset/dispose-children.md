---
'@kidlib/web-audio': patch
---

`SamplePlayer.dispose()` now releases its whole graph. The instrument bus effect chain and each voice's harmonic feedback stayed in the node registry after dispose, so every created player kept about 30 nodes alive.
