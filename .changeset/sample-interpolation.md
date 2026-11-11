---
'@kidlib/web-audio': minor
---

Sample playback now uses 4-point Hermite interpolation instead of linear. Add experimental `SamplePlayer.setInterpolation('linear' | 'hermite' | 'sinc')`; `'sinc'` band-limits reads when pitching up, at a much higher CPU cost.
