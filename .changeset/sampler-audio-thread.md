---
'@kidlib/web-audio': patch
---

`SamplePlayer` runs all voices in one audio-thread processor that also allocates voices and computes pitch. Scheduled notes steal voices when they start, and `voice:*` events arrive a few ms after `play()`/`release()`.
