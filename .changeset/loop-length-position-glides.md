---
'@kidlib/web-audio': minor
---

Split the loop glide into separate length and position controls.

- `setLoopLengthGlide()` and `samplerParams.loopLengthGlide` replace `setLoopRampDuration()` and `samplerParams.loopRampDuration`.
- `setLoopPositionGlide()` and `samplerParams.loopPositionGlide` add a glide for moving a quantized audio-rate loop through the sample without changing its length (`0` = instant, the default).
