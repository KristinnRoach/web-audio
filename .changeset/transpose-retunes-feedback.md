---
'@kidlib/web-audio': patch
---

`SamplePlayer.transpose()` and `fineTune()` now retune feedback on held notes, on both the voices and the bus. Previously feedback stayed at the old pitch until the next note-on.
