---
"@kidlib/web-audio": patch
---

Remove duplicate pitch detection from `SamplePlayer`

`SamplePlayer.detectPitch` and `SamplePlayer.detectedPitchToTransposition`
duplicated the preprocessor's equivalents and had no callers. Both are gone,
along with the `sample:pitch-detected` message they emitted, which nothing
listened for.

No pitch-detection function is exported from the package root; detection stays
reachable through the preprocess options on `loadSample` and `loadLayers`.
