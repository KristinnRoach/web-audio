---
'@kidlib/web-audio': minor
---

Sampler pitch LFO modulates `detune` instead of `playbackRate`, so its interval no longer depends on the base rate. `player.pitchLFO.setDepth()` now takes cents; the `pitchLFODepth` control keeps its normalized 0–1 value and displays its mapped depth in cents (0–~165). LFO rate controls now show their value in Hz, and the amp LFO rate control default is 0.05 (5.1 Hz).
