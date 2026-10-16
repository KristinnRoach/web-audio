---
'@kidlib/web-audio': patch
---

`setLoopDurationDriftAmount` passes its amount straight through instead of mapping it geometrically, so it no longer does almost nothing below 50%. The `loopDurationDrift` descriptor uses `curve: 2` with a 0.03 default. Unitless sampler param readouts show knob position as a percentage, and `samplerParamPosition` is exported.
