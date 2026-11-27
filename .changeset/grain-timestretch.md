---
'@kidlib/web-audio': minor
---

Add `'grain'` timestretch mode to SamplePlayer. It keeps the sample's duration at any pitch by restarting the read every 30 ms at original speed, with overlapping fades. Unlike `'period'`, it needs no pitch detection, so it also works on drums, chords and noise.
