---
"@kidlib/web-audio": patch
---

Loop and envelope fixes:

- Short loops played above rate 1 now hold their pitch (forward and reverse).
- Finer `loopStart`/`loopEnd` step resolution (`0.001` -> `0.0001`), needed for short loops in samples longer than ~1.9s.
- Pan drift depth no longer varies with loop length, and is off for audio-rate loops.
- Fix click on amp envelopes release start when sustain is enabled.

Note: `loopEnd` now precedes `loopDuration` in `samplerParams`. Both write the loop end, so hosts applying params in declaration order will see `loopDuration` win. Defaults unchanged.
