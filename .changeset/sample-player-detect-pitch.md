---
'@kidlib/web-audio': minor
---

Add `SamplePlayer.detectPitch()`, which returns `{ midiFloat, frequency, periodicity }` for the loaded sample, using the same detector as autotune with a fixed 30 Hz highpass, without changing the sample. Returns `null` when no sample is loaded.
