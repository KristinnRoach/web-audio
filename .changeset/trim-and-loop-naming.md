---
'@kidlib/web-audio': minor
---

Standardize trim and loop range naming on `SamplePlayer` and its worklet processor:

- Rename `setSampleStartPoint()` / `setSampleEndPoint()` to `setTrimStart()` / `setTrimEnd()`.
- Replace `getStartPoint()` / `getEndPoint()` with `trimStart` / `trimEnd` getters.
- Rename `scrollLoopPoints()` to `scrollLoopPosition()`.
- Rename the `loop-points:updated` event to `loop-range:updated`.
- Rename `trim:range` message fields and worklet `startPoint` / `endPoint` AudioParams to `trimStart` / `trimEnd`.
