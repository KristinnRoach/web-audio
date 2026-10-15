---
'@kidlib/web-audio': minor
---

Loop length snapping to the scale now runs in the audio processor instead of on the main thread.

- `SamplePlayer.setScale()` sets the loop lengths that audio-rate loops snap to. The `loopStart`/`loopEnd` getters and `loop-points:updated` report the raw points, not the snapped loop. Snapping adjusts the end; containment can shift the loop inside trim. When trim is within the snapping range and shorter than the target, the longest scale period that fits becomes the target before glide. If none fits, the existing minimum and containment rules apply.
- New `loop:range` (`{ loopStart, loopEnd }`) and `trim:range` (`{ startPoint, endPoint, inverted }`) messages on `SamplePlayer`, in seconds: the loop and trim a playing voice actually plays, after ordering, zero-crossing snaps, minimum length, loop snapping and glide. `inverted` means the trim plays backward. Sent on change, at most ~30 times a second per voice, and only while a voice is playing. `loop-points:updated`, `start-point:updated` and `end-point:updated` still report the raw points.
- `SamplePlayer.setScale()` no longer takes `normalize`, and throws a `RangeError` for invalid options: an empty scale, notes outside integers 0–11, non-integer octaves, `lowestOctave` above `highestOctave`, `highestOctave` above 9, or a non-finite `tuningOffset`.
- `SamplePlayer.setLoopRampDuration()` now sets the time constant of the processor's glide between snapped loop lengths (`0` = stepped, default `0.125`). Remove the `rampTime` argument from `SamplePlayer.setLoopStart()`, `setLoopEnd()`, `setLoopDuration()` and `setLoopPoint()`.
- `SamplePlayer.getAudioParam()` returns `null`. Loop points are set per voice and no longer have a shared `AudioParam`.
