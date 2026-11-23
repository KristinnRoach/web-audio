---
'@kidlib/web-audio': minor
---

Add `SamplePlayer.setTrimRange()` and rename `setLoopPoints()` to `setLoopRange()` for consistent range naming. Both setters schedule their two points at one shared event time.
