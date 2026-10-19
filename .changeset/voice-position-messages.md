---
'@kidlib/web-audio': minor
---

- `SamplePlayer.enablePositionTracking(true)` emits per-voice `voice:position` (`{ voiceId, midiNote, position }`, 0..1, ~60/s). It is off by default.
- `voice:releasing` carries `releaseDuration` in seconds.
- The `releaseTime` argument is removed from `releaseAll`, `SampleVoicePool.noteOff`/`allNotesOff` and `SampleVoice.release`. Release timing comes from the amp envelope.
