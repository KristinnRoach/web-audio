---
'@kidlib/web-audio': patch
---

Export `samplerParamPosition`. Unitless param readouts show knob position as a percentage. `loopDurationDrift` uses `curve: 2` with a default of 0.07, and `loopStart`/`loopEnd` precision goes from 0.0001 to 0.00001.
