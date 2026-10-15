---
'@kidlib/web-audio': minor
---

Loop length snapping to the scale now runs in the audio processor instead of on the main thread.

- `SamplePlayer.setScale()` sets the loop lengths that audio-rate loops snap to. The `loopStart`/`loopEnd` getters and `loop-points:updated` report the raw points, not the snapped loop. The start stays fixed and the end moves.
- `SamplePlayer.setScale()` no longer takes `normalize`, and throws a `RangeError` for invalid options: an empty scale, notes outside integers 0–11, non-integer octaves, `lowestOctave` above `highestOctave`, `highestOctave` above 9, or a non-finite `tuningOffset`.
- `SamplePlayer.setLoopRampDuration()` now sets the time constant of the processor's glide between snapped loop lengths (`0` = stepped, default `0.125`). Remove the `rampTime` argument from `SamplePlayer.setLoopStart()`, `setLoopEnd()`, `setLoopDuration()` and `setLoopPoint()`.
- `SamplePlayer.getAudioParam()` returns `null`. Loop points are set per voice and no longer have a shared `AudioParam`.
