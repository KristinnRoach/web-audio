---
'@kidlib/web-audio': minor
---

`SamplePlayer.enablePositionTracking(true)` makes `SamplePlayer` emit `voice:position` (`{ voiceId, midiNote, position }`) per sounding voice, with `position` as 0..1 of the sample. Off by default. Like `loop:range`, each note posts on change, at most ~60 times a second per voice, and none after the voice stops; key on `voiceId` and drop it on `voice:stopped`. Previously `voice:position` was posted every render block when enabled per voice, untagged, and not forwarded from the voice pool.

`voice:releasing` now carries `releaseDuration`: the amplitude envelope's release-stage duration in seconds, even when that envelope is disabled. Cleanup is scheduled for the release start plus that duration and a 50 ms buffer; natural playback completion can stop the voice sooner. Lifecycle messages report state when the release is scheduled, so `releaseDuration` excludes any `secondsFromNow` delay. Amplitude shapes ending above zero are cut off at cleanup.

Remove the obsolete `releaseTime` duration override from `SamplePlayer.releaseAll`, `SampleVoicePool.noteOff`/`allNotesOff`, and `SampleVoice.release`. Release timing comes from the envelopes; `SampleVoice.stop()` remains the explicit hard stop. Zero-length amplitude releases now follow the normal release lifecycle, including the 50 ms cleanup buffer.
