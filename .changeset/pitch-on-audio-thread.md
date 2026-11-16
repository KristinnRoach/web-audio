---
'@kidlib/web-audio': patch
---

`SamplePlayer` now works out note pitch on the audio thread. `transpose()`, `fineTune()` and `setPitchEnabled()` retune held notes, and a legato note-off that falls back to an earlier held note retunes it, without waiting for a main-thread round trip; the API is unchanged.
