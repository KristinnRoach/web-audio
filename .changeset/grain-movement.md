---
'@kidlib/web-audio': minor
---

Add grain controls to SamplePlayer for `'grain'` timestretch: `setGrainSpeed` (time position speed; 0 freezes), `setGrainScatter` (random offset of each grain's start, in seconds) and `setGrainSize` (grain length in seconds). Each voice scatters with its own random values. `samplerParams` gains `grainSpeed`, `grainScatter` and `grainSize`.
