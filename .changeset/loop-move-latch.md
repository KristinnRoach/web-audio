---
'@kidlib/web-audio': patch
---

Dragging a short (pitch-range) `SamplePlayer` loop with position glide off is smoother: moves that arrive during a move crossfade wait for it to end, then catch up in one fade, instead of stacking a fade per sample.
