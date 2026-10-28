---
'@kidlib/web-audio': minor
---

- Add `SamplePlayer.transpose(semitones)` and `fineTune(cents)`, with `transpose` and `fineTune` params. Held notes retune too.
- Add `SamplePlayer.commitPitch()` to bake transpose and fineTune into the samples. Posts `pitch:committed` with `{ semitones }`.
- Add `SampleVoice.setPitchOffset(semitones)`.
- Breaking: remove `SamplePlayer.setRootNote`. Use `transpose(semitones)`.
- Breaking: transposition persists across sample loads.
- Breaking: rename `SamplePlayer.setScale` to `setLoopPitchQuantization`, remove `rootNote` and `tuningOffset` (shift `scale` intervals instead) and make all options optional.
- Breaking: remove the `SamplePlayer.transposeSemitones` setter.
- Breaking: remove `SampleVoice.setAllowedPeriods`, `setPlaybackRate`, `setStartPoint` and `setEndPoint`.
- Breaking: `note:off`, `voice:started` and `voice:stopped` report the played note, not the transposed one. `note:off` sends `{ midiNote }`.
