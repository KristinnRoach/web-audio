---
'@kidlib/web-audio': minor
---

Loop length snapping to the scale now runs in the audio processor instead of on the main thread.

- `SamplePlayer.setScale()` sets the loop lengths that audio-rate loops snap to. The `loopStart`/`loopEnd` getters and `loop-points:updated` report the raw points, not the snapped loop. Snapping adjusts the end; containment can shift the loop inside trim. When trim is within the snapping range and shorter than the target, the longest scale period that fits becomes the target before glide. If none fits, the existing minimum and containment rules apply.
- New `loop:range` (`{ voiceId, midiNote, loopStart, loopEnd, loopMode }`) and `trim:range` (`{ voiceId, midiNote, startPoint, endPoint, inverted }`) messages on `SamplePlayer`, positions in seconds: the loop and trim a playing voice actually plays, after ordering, zero-crossing snaps, minimum length, loop snapping and glide. Ranges are per voice, since keytracked and snapped loops can resolve differently for each note; key on `voiceId` and drop it on `voice:stopped`. Each note posts its first range when it starts, then on change, at most ~30 times a second per voice, and none after the voice stops. `inverted` means the trim plays backward. `loopEnd` can exceed the sample duration when a keytracked loop is padded with silence. `loop-points:updated`, `start-point:updated` and `end-point:updated` still report the raw points.
- `voice:started` now includes `voiceId`, matching `voice:stopped`. `voice:initialized`, `voice:started`, `voice:releasing` and `voice:stopped` no longer include the `voice` object; use `voiceId` and `midiNote`.
- `SamplePlayer.setScale()` no longer takes `normalize`, and throws a `RangeError` for invalid options: an empty scale, notes outside integers 0–11, non-integer octaves, `lowestOctave` above `highestOctave`, `highestOctave` above 9, or a non-finite `tuningOffset`.
- The default loop scale now starts at C1 instead of C0, reducing the longest snapping period from ~61 ms to ~31 ms. Pass `lowestOctave: 0` to `setScale()` to restore the previous range.
- `SamplePlayer.setLoopRampDuration()` now sets the time constant of the processor's glide between snapped loop lengths (`0` = stepped, default `0.125`). Remove the `rampTime` argument from `SamplePlayer.setLoopStart()`, `setLoopEnd()` and `setLoopDuration()`.
- `SamplePlayer.getAudioParam()` returns `null`. Loop points are set per voice and no longer have a shared `AudioParam`.
- `SamplePlayer.scrollLoopPoints(start)` replaces the two-argument form. It preserves the current signed loop length and keeps both points inside the sample, including inverted ranges.
- `samplerParams.loopRampDuration` now ranges 0–0.5 s (was 0.001–1) with a linear taper and defaults to 0.125 (was 0.5). It only affects loops inside the snapping range, gliding when the snapped length changes during a held note; longer loops and new notes jump to the target.
