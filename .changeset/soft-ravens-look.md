---
'@kidlib/web-audio': patch
---

`EnvelopeRuntime.position(time?)` reports how far into its shape a live run has got, or null when no run is live. The unit is seconds of envelope time, measured from `points[0].time`, so it is not wall seconds since the trigger: a run at twice speed reaches position 1 after half a second. A loop wraps it into one cycle, a sustained run clamps it at the sustain point.

The scheduler already computed this internally to hand a future-dated release the value the envelope will actually have reached; it just had no way out. `EnvelopeScheduler.position` exposes the same number. No behaviour change.

A non-finite `time` argument throws `RangeError` rather than returning `NaN` or `null`: null already means "no live run", so overloading it would leave a caller unable to tell a missing run from a bad timestamp. `EnvelopeRuntime.trigger` also validates a caller-supplied `options.envelope`, which it previously took on trust.
