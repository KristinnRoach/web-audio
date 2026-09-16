---
"@kidlib/web-audio": minor
---

Envelopes now run on one scheduler. Removed the `CustomEnvelope` and `EnvelopeData` exports and `SamplePlayer.getEnvelope()`, which was already deprecated; use `getEnvelopeState()` and `applyEnvelopeState()`. `SamplePlayer` is now the single owner of envelope state, so a snapshot no longer depends on which voice is read.
