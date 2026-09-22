---
'@kidlib/web-audio': patch
---

Envelopes now use one generic scheduler and runtime. Removed the `CustomEnvelope` and `EnvelopeData` exports and deprecated `SamplePlayer.getEnvelope()`; use `getEnvelopeConfig()` and `applyEnvelopeConfig()`. `SamplePlayer` now owns sampler envelope configs and passes detached snapshots to each voice.
