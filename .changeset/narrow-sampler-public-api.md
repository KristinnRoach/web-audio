---
'@kidlib/web-audio': minor
---

Narrow the SamplePlayer public API while preserving sampler descriptor behavior.

- Remove the legacy `setParam()`, `getParameterValue()`, and null-only `getAudioParam()` methods. Use `applyParams()`, `samplerParams`, or dedicated controls instead.
- Replace mutable `gainLFO` and `pitchLFO` access with `setGainLFOFrequency()`, `setGainLFODepth()`, `setPitchLFOFrequency()`, and `setPitchLFODepth()`. Frequencies are in Hz; pitch depth is in cents.
- Keep draft graph bookkeeping (`addIncoming`, `removeIncoming`, `connections`) private.
- Remove the `audioNode` alias in favor of `output`, and the deprecated `setModulationAmount` alias in favor of `setModulationDepth`.
