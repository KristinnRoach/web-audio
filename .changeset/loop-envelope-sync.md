---
'@kidlib/web-audio': patch
---

Keep loop-mode envelopes in sync with a looping sample. Zero-crossing snapping made the played loop shorter than the loop as set, so envelopes drifted out of phase over a held note; they now absorb that shortfall from the first note.
