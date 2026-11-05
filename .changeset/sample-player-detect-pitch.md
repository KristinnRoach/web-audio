---
'@kidlib/web-audio': minor
---

Add `SamplePlayer.detectPitch()`, which returns `{ midiFloat, frequency, periodicity }` for the loaded sample, using the same preparation and detector as autotune, without changing the sample. Returns `null` when no sample is loaded.
