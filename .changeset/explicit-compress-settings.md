---
"@kidlib/web-audio": patch
---

Explicit `compress` settings passed to `preProcessAudioBuffer` are now applied instead of being discarded when the crest factor analysis decides the audio doesn't need compression. The analysis only runs when no settings are given.
