---
'@kidlib/web-audio': minor
---

Loop snapping to the scale runs in the audio processor.

- New per-voice `loop:range` (`{ voiceId, midiNote, loopStart, loopEnd, loopMode }`) and `trim:range` (`{ voiceId, midiNote, startPoint, endPoint, inverted }`) messages report what a voice actually plays, in seconds. Key on `voiceId` and drop it on `voice:stopped`. `loop-points:updated` and the point getters still report raw values.
- `voice:started` includes `voiceId`. Lifecycle messages no longer include the `voice` object; use `voiceId` and `midiNote`.
- `setScale()`: the `normalize` option is removed, invalid options throw `RangeError`, and the default scale starts at C1 (pass `lowestOctave: 0` for the old range).
- `setLoopRampDuration()` sets the glide time constant between snapped loop lengths (`0` = stepped, default `0.125`). `samplerParams.loopRampDuration` is now 0–0.5 s, linear. The `rampTime` argument is removed from `setLoopStart()`, `setLoopEnd()` and `setLoopDuration()`.
- `scrollLoopPoints(start)` replaces the two-argument form.
- `getAudioParam()` returns `null`.
