---
'@kidlib/web-audio': minor
---

Instruments, effects and modulators accept any `BaseAudioContext`, including `OfflineAudioContext`. `SamplePlayer.context` and `InstrumentBus.context` are now typed `BaseAudioContext`.
