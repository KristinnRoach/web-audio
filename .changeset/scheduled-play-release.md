---
'@kidlib/web-audio': patch
---

`SamplePlayer.play()` and `release()` take an optional `secondsFromNow`, which schedules the note on the audio clock. It was already supported by the voice pool but not reachable from the player. Existing calls are unchanged.
