---
'@kidlib/web-audio': minor
---

SamplePlayer loop changes now apply at the next wrap or turn instead of mid-pass. Moving, resizing or modulating the loop, changing loop mode, and loop drift are heard from the next loop edge, under its crossfade. Time loops still take moves and resizes mid-pass. A pitch loop that moves to a new start gets a longer crossfade. `loop:range` reports the loop window that is playing.
