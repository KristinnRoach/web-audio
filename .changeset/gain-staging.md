---
'@kidlib/web-audio': minor
---

Fix distortion and pumping on chords in `SamplePlayer`. Voices now sum with about 9 dB of headroom, and the bus compressor is out of the signal path, so the limiter only catches rare peaks. Output is quieter than before, most of all on single notes; raise `setVolume()` to compensate. `setCompressorParams()` and `getCompressor()` remain but no longer affect the sound.

AM and the amp LFO now dip below the unmodulated level instead of boosting above it, so raising their depth no longer adds up to 6 dB.
