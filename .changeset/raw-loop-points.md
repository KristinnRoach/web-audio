---
'@kidlib/web-audio': patch
---

Loop and trim points no longer clamp against each other, so the order you set them in doesn't matter.

- `setLoopStart`, `setLoopEnd`, `setParam` and `applyParams` store each value as given, clamped only to the sample length. The `loopStart`/`loopEnd` getters and `loop-points:updated` return those values, not the loop that plays, and the start can be past the end.
- Playback resolves trim and loop points by one rule: either order, inside their bounds (the sample for trim, the trim range for the loop). Trim and loop share a minimum: the smaller of one C5 period (~1.9 ms) and the shortest scale period, or C5 without a scale. Shorter available audio takes precedence. Loop snapping lifts a short loop to the shortest scale period when possible. Equal or out-of-range points no longer fall back to a larger range. You can drop any code that clamps these points against each other.
- Trim points with the start past the end play backward, and `setPlaybackDirection('reverse')` flips that again. Inverted loop points loop forward. `cropSample` accepts points in either order.
