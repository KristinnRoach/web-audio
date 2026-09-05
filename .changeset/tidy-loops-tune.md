---
"@kidlib/web-audio": patch
---

Finer loop-point resolution and audio-rate loop tuning fixes

- `samplerParams.loopStart.step` and `samplerParams.loopEnd.step`: `0.001` -> `0.0001`.
  Steps are normalized, so absolute resolution is `step * sampleDuration`. The old
  step could not reach the minimum loop duration (1.91ms) on samples longer than
  ~1.9s; the new one holds up to ~19s.
- `loopEnd` now precedes `loopDuration` in `samplerParams`. Both write the loop end,
  so hosts that apply every param in declaration order will see `loopDuration` win
  where `loopEnd` used to. Defaults are unchanged and still agree.

Loops shorter than ~61ms played above rate 1 now hold their pitch: the wrap keeps
the fractional overshoot instead of snapping to the loop start, and click
compensation is bypassed where its ramp was the aliasing source. Applies to reverse
playback too.

Pan drift now tracks the loop's relative stretch rather than its raw sample count,
so its depth no longer depends on loop length, and it is off for audio-rate loops.
