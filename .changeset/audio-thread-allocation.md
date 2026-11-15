---
'@kidlib/web-audio': patch
---

`SamplePlayer` now picks voices on the audio thread, when a note sounds. A note scheduled ahead with `secondsFromNow` no longer takes a voice at scheduling time, so it steals from whatever is playing when it starts.

Voice state on the main thread follows the audio thread's reports. `voice:started`, `voice:releasing` and `voice:stopped` arrive a few milliseconds after `play()` or `release()` (or at the scheduled time), and per-voice feedback and AM pitch are set at that point.
