---
'@kidlib/web-audio': minor
---

A disabled sampler amp envelope now plays the note as a gate: `envGain` holds at unity (the processor applies velocity once) while the note is held and fades out over a 2 ms time constant on release. Previously the note was silent, or held at whatever level the envelope had reached when it was switched off mid-note. Disabled or flat pitch and filter envelopes reset their detune immediately to 0 on every trigger; disabling a live envelope still uses smoothing. Velocity is no longer multiplied into both the amp envelope and the processor, correcting the extra attenuation of lower-velocity notes.
