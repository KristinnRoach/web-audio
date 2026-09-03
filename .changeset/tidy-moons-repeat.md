---
"@kidlib/web-audio": patch
---

Consolidate duplicate pitch detection into `detectPitchWithNote`

`SamplePlayer.detectPitch` and the module-local `detectPitch` in the
preprocessor were the same function. Both are now `detectPitchWithNote`,
exported from the package root.

Removed from `SamplePlayer`: `detectPitch` and `detectedPitchToTransposition`
(a byte-identical copy of the preprocessor's), plus the unlistened
`sample:pitch-detected` message they emitted. Nothing called either method.
