---
"@kidlib/web-audio": patch
---

Remove the unconditional ±0.999 output clamp from the distortion worklet, which hard-clipped any signal above 0 dBFS even with drive and clipping at zero. The bus limiter already protects the output. Also raise the minimum `clippingThreshold` above zero, since a zero threshold produced NaN and silenced everything downstream.
