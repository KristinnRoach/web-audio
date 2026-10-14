---
'@kidlib/web-audio': patch
---

Loop points no longer clamp against each other, so the order you set them in doesn't matter. `applyParams({ loopStart: 0.6, loopEnd: 0.8 })` now gives 0.6–0.8 whatever the previous loop was. Before, the start could get stuck at the old end.

`setLoopStart`, `setLoopEnd`, `setParam` and `applyParams` store each value as given, clamped only to the sample length. A loop short enough to be pitched still snaps to the scale. The `loopStart`/`loopEnd` getters and the `loop-points:updated` message return those stored values. They are not the loop that plays, and the start can be greater than the end.

What plays is worked out during playback: the two points in either order, kept inside the trim range, and at least one C5 period (~1.9 ms) long. If both points are equal, the whole trim range loops. You can drop any code that clamps loop points against each other.
