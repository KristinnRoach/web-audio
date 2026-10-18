---
'@kidlib/web-audio': minor
---

A disabled sampler amp envelope now plays the note as a gate: `envGain` holds at velocity / 127 while the note is held and fades out over a 2 ms time constant on release. Previously the note was silent, or held at whatever level the envelope had reached when it was switched off mid-note. Disabled or flat pitch and filter envelopes also reset their detune to 0 on every trigger.
