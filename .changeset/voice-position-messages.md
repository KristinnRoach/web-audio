---
'@kidlib/web-audio': minor
---

`SamplePlayer.enablePositionTracking(true)` makes `SamplePlayer` emit `voice:position` (`{ voiceId, midiNote, position }`) per sounding voice, with `position` as 0..1 of the sample. Off by default. Like `loop:range`, each note posts on change, at most ~60 times a second per voice, and none after the voice stops; key on `voiceId` and drop it on `voice:stopped`. Previously `voice:position` was posted every render block when enabled per voice, untagged, and not forwarded from the voice pool.

`voice:releasing` now carries `releaseDuration`: the amplitude envelope's release-stage duration in seconds. The voice stops after that duration plus a 50 ms buffer.
