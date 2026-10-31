---
'@kidlib/web-audio': minor
---

- Timestretch correction jumps now crossfade for 10 ms by default, shortened near trim/loop edges and at high playback rates. Add `SamplePlayer.setCrossfadeDurationMs(ms)` and `SampleVoice.setCrossfadeDurationMs(ms)`; `0` restores the hard jump.
- Timestretch drift window shrinks from 40 ms to 30 ms, so corrections happen slightly more often.
