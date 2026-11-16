---
'@kidlib/web-audio': patch
---

Fix clipping and pumping on chords. Output is quieter (more headroom, bus compressor bypassed), but the `volume` default rises to 0.75. AM, amp LFO, distortion and feedback add less loudness at high settings. `setCompressorParams()` no longer affects the sound.
