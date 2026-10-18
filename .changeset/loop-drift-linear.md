---
'@kidlib/web-audio': patch
---

Unitless sampler param readouts show knob position as a percentage, and `samplerParamPosition` is exported. `loopDurationDrift` uses `curve: 2` to distribute control values more evenly, with a control default of 0.07.
