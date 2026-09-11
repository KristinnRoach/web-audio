---
"@kidlib/web-audio": patch
---

Normalize the distortion worklet's clipped path to a fixed output ceiling instead of scaling with the clipping threshold. The old makeup gain (`sqrt(0.1/t)`, capped at 2x, and only applied below a threshold of 0.08) left the clipped signal far below the dry signal, so the blend crossfaded from loud to quiet and the `distortion` macro lost roughly 7 dB over the last 10% of its travel. Worst step is now about 2.5 dB. Distortion at high macro settings is louder than before.
