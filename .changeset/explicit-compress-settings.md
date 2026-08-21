---
"@kidlib/web-audio": patch
---

When compression is enabled, an explicit `threshold`, `ratio`, or `makeupGain` passed to `preProcessAudioBuffer` is now applied instead of being discarded when the crest factor analysis decides the audio doesn't need compression. The analysis only runs when none of the three are given.
