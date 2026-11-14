---
'@kidlib/web-audio': minor
---

Instruments, effects and modulators now accept any `BaseAudioContext`, so they can render on an `OfflineAudioContext`. `SamplePlayer` no longer warns when an offline render finishes.
