---
'@kidlib/web-audio': minor
---

Sampler envelopes:

- A disabled amp envelope plays the note as a gate (unity while held, ~10 ms fade on release) instead of going silent.
- Velocity is applied once. It was applied twice before, which made soft notes too quiet.
- Pitch and filter envelopes now modulate detune, so changing cutoff, glide or keytracking no longer overwrites a running envelope. When disabled, they reset detune to 0 on every trigger.
- `EnvelopeConfig` accepts an optional `depth` (default 1: gain for amp, 1200 cents for pitch, 12000 cents for filter).
