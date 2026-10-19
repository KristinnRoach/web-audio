---
'@kidlib/web-audio': minor
---

Loop modes:

- Inverted loop points (start after end) now loop backward. They used to loop forward over the same region.
- `SamplePlayer.setLoopPingPong(true)` turns loops around at both edges.
- Modes are relative to the voice direction. `loop:range` reports `loopMode` (`'forward' | 'backward' | 'pingPong'`).
