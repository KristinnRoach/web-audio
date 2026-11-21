---
'@kidlib/web-audio': patch
---

Moving a short (pitch-range) `SamplePlayer` loop crossfades from the old position to the new one at the same phase over 20 ms, also for the shortest loops, which previously got fades of a few samples.
