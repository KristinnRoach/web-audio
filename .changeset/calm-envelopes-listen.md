---
"@kidlib/web-audio": minor
---

Add `SamplePlayer.getEnvelopeState()` / `applyEnvelopeState()` for serializable
envelope snapshots, plus `EnvelopeState`, `PointEnvelopeShape` and
`SampleEnvelopeType` exports. Every envelope mutator now emits a single
`envelope:changed` message carrying the full state.

`getEnvelope()` is deprecated. Prefer the state APIs.

Envelope release behavior changed:

- Looping envelopes no longer auto-release. The note is held until an explicit
  release, or until the loop is switched off, which fires the missed release.
- Changing the sustain point mid-note resumes from the envelope's current
  position instead of restarting the curve, and now applies while looping too.
