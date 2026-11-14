---
'@kidlib/web-audio': minor
---

Instruments, effects and modulators now accept any `BaseAudioContext`, so they can render on an `OfflineAudioContext`. `SamplePlayer` no longer warns when an offline render finishes.

`SamplePlayer.context` and `InstrumentBus.context` now expose `BaseAudioContext`. Keep your original `AudioContext` reference for real-time methods such as `close()`, `resume()`, and output-device selection.
