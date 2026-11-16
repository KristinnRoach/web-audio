---
'@kidlib/web-audio': patch
---

`SamplePlayer` runs all its voices in one AudioWorklet processor instead of one per voice. The sample is copied to the audio thread once, not once per voice. Sound and API are unchanged.
