---
'@kidlib/web-audio': minor
---

Add `setTimestretchMode('period')`: a timestretch that jumps whole pitch periods, for cleaner high notes on pitched samples. Audio without a clear pitch falls back to short splices. Selecting it runs pitch tracking on the main thread, about 0.05 s per second of audio. `'off'` and `'splice'` are unchanged.
