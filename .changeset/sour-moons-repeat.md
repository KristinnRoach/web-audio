---
"@kidlib/web-audio": patch
---

Fix gain staging in the voice and distortion paths. A dry bypass around `HarmonicFeedback` doubled the voice output (+6 dB) even at zero feedback. The distortion worklet no longer hard-clips above 0 dBFS, and its clipped path normalizes to a fixed ceiling instead of scaling with the threshold, so the `distortion` macro no longer loses ~7 dB over the top of its travel.

Distortion at high macro settings is louder than before.
