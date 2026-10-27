---
'@kidlib/web-audio': minor
---

- Add `SamplePlayer.transpose(semitones)` and the `tune` param. Held notes retune too.
- Add `SamplePlayer.commitRePitchedSamples(semitones)` and the `sourceSampleTune` param.
- Add `SampleVoice.setPitchOffset(semitones)`.
- Breaking: `setRootNote` now only transposes and no longer rebuilds loop snap periods.
- Breaking: transposition persists across sample loads.
- Breaking: remove `tuningOffset` from `SamplePlayer.setScale`.
- Breaking: remove the `SamplePlayer.transposeSemitones` setter.
- Breaking: remove `SampleVoice.setAllowedPeriods`, `setPlaybackRate`, `setStartPoint` and `setEndPoint`.
- Breaking: `note:off`, `voice:started` and `voice:stopped` report the played note, not the transposed one. `note:off` sends `{ midiNote }`.
