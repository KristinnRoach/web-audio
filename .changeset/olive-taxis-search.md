---
'@kidlib/web-audio': patch
---

Envelopes now use one generic scheduler and runtime. Removed the `CustomEnvelope` and `EnvelopeData` exports and deprecated `SamplePlayer.getEnvelope()`; use `getEnvelopeSettings()` and `applyEnvelopeSettings()`. `SamplePlayer` now owns sampler envelope settings and passes detached snapshots to each voice.
