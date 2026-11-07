---
'@kidlib/web-audio': minor
---

Add `setTimestretchMode('period')`: a timestretch that jumps whole pitch periods, for cleaner high notes on pitched samples. Audio without a clear pitch falls back to short splices. Selecting it runs pitch tracking on the main thread, about 0.05 s per second of audio, so it suits short samples; long recordings will stall the UI. `'off'` is unchanged.

Fix timestretch on the way into a loop: with a non-zero `loopStart`, or `loopEnd` before the sample end in reverse, loop-only rules no longer apply until playback reaches the loop. This also changes `'splice'`, which now crossfades those jumps and stretches the lead-in to ping-pong, backward and short loops. `'period'` also stretches inside backward and ping-pong loops; `'splice'` still doesn't.
