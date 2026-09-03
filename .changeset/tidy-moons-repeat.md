---
"@kidlib/web-audio": patch
---

Remove duplicate pitch detection from `SamplePlayer`

`SamplePlayer.detectPitch` and `SamplePlayer.detectedPitchToTransposition`
duplicated the preprocessor's equivalents and had no callers. Both are gone,
along with the `sample:pitch-detected` message they emitted, which nothing
listened for.

`detectSinglePitchAC` is now exported from the package root as the pitch
detection entry point. The note lookup and MIDI conversion the removed method
layered on top were a reimplementation of the existing `findClosestNote` and
`frequencyToMidi`, so they stay at the call site rather than behind a wrapper.
