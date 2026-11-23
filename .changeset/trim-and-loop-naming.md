---
'@kidlib/web-audio': minor
---

Standardize trim and loop range naming on `SamplePlayer` and its worklet processor:

- Rename `setSampleStartPoint()` / `setSampleEndPoint()` to `setTrimStart()` / `setTrimEnd()`.
- Replace `getStartPoint()` / `getEndPoint()` with `trimStart` / `trimEnd` getters.
- Rename `scrollLoopPoints()` to `scrollLoopPosition()`.
- Remove the `loop-points:updated` event; use the per-voice `loop:range` report (emitted for active voices) or `loopStart` / `loopEnd` getters instead.
- Rename `trim:range` message fields and worklet `startPoint` / `endPoint` AudioParams to `trimStart` / `trimEnd`.
