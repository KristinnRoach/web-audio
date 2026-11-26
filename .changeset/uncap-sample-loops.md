---
'@kidlib/web-audio': patch
---

Remove the SamplePlayer worklet's maximum loop count. Enabled loops keep cycling while the voice plays.

Pitch-loop legato responds to playback entering or leaving a pitch loop on the next render block, independently of throttled loop-range reports.
