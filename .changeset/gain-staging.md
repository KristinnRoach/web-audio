---
'@kidlib/web-audio': minor
---

Fix distortion and pumping on chords in `SamplePlayer`. Voices now sum with about 9 dB of headroom, and the bus compressor is out of the signal path, so the limiter only catches rare peaks. Output is quieter than before, most of all on single notes; raise `setVolume()` to compensate. `setCompressorParams()` and `getCompressor()` remain but no longer affect the sound.

AM and the amp LFO now dip below the unmodulated level instead of boosting above it, so raising their depth no longer adds up to 6 dB.

The distortion macro now lowers its output as it goes up (up to -15 dB at full), offsetting the loudness that drive and clipping add.

Harmonic feedback auto-gain is now on, so the top of the Feedback knob adds less loudness. Above feedback 0.8 its output also comes from the soft-clipped loop signal.
