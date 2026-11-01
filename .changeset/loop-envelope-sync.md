---
'@kidlib/web-audio': patch
---

Add opt-in `loopSync` to `EnvelopeConfig`. A loop-mode sampler envelope then follows the audible sample loop: at `timeScale: 1`, a shape spanning the loaded buffer's duration plays once per loop, including the note's playback rate (overriding `playbackRateSync`). It restarts at each loop boundary and has no effect unless both the envelope and the sample are looping. Known issue: intermittent clicks at loop boundaries.
