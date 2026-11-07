---
'@kidlib/web-audio': minor
---

Add `setTimestretchMode('period')`: a timestretch that jumps whole pitch periods, for cleaner high notes on pitched samples. It also stretches inside backward and ping-pong loops. Audio without a clear pitch falls back to short splices. Selecting it runs pitch tracking on the main thread, about 0.05 s per second of audio, so it suits short samples; long recordings will stall the UI. `'off'` is unchanged.

Breaking: remove `setTimestretchMode('splice')`. Use `'period'`.
