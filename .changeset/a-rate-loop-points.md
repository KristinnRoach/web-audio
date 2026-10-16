---
'@kidlib/web-audio': minor
---

Loop start and end AudioParams now accept a-rate automation. Short (pitched) loops follow it per sample; long loops follow it once per render block, as before. Scale snapping feeds a sample-rate log-duration glide, with zero ramp retaining stepped targets. Moving short loops carry fractional wrap overshoot with their source offset. Drift updates follow loop passes rather than render blocks. Trim remains k-rate, and SamplePlayer.getAudioParam() still returns null.
