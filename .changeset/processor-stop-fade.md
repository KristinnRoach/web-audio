---
'@kidlib/web-audio': patch
---

`SamplePlayer` voices now stop on the audio clock with a short de-click fade. Scheduled stops are sample accurate instead of following a main-thread timer, and released voices free up when their amp tail ends rather than 50 ms after it. With the amp envelope off, notes start at full level and note-off fades over 64 frames.
