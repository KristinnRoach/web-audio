---
"@kidlib/web-audio": patch
---

- `defaultEnvelopeState(type: EnvelopeType, durationSeconds?: number): EnvelopeState` - Added a public helper for duration-scaled, serializable envelope defaults.
- `SamplePlayer.resetEnvelope(type: EnvelopeType): void` - Added a method to reset one envelope using the current sample duration.
- `SamplePlayer.resetEnvelopes(): void` - Added a method to reset all sample envelopes using the current sample duration.
- `CustomEnvelope.getDefaults(envType: EnvelopeType, durationSeconds?: number)` - Removed; use `defaultEnvelopeState` instead.
- `EnvelopeType` - Removed the unsupported `"loop-env"` and `"default-env"` literals.
- `SampleEnvelopeType` - Removed; use `EnvelopeType` instead.
