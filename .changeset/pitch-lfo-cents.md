---
'@kidlib/web-audio': minor
---

Sampler pitch LFO modulates `detune` instead of `playbackRate`, so its interval no longer depends on the base rate. `player.pitchLFO.setDepth()` now takes cents; the `pitchLFODepth` control maps 0–1 to 0–~165 cents. LFO rate controls now show their value in Hz.
