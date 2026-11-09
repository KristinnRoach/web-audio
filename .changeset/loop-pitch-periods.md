---
'@kidlib/web-audio': patch
---

Add `SamplePlayer.getLoopPitchPeriods()` to read configured pitch-loop targets in seconds, shortest first, before playback-rate transposition. Pass a returned period to `setLoopDuration()` to select a pitch loop. The returned array is a copy and reflects `setLoopPitchQuantization()` settings, including those set before `init()`.
