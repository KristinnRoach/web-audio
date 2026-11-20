---
'@kidlib/web-audio': patch
---

`SamplePlayer` keeps the waveform's slope when a crossfade or ping-pong turn reads past the start of the sample, instead of flattening it.
