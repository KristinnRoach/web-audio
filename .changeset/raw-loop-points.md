---
'@kidlib/web-audio': patch
---

Loop points no longer clamp against each other, so the order you set them in doesn't matter. `applyParams({ loopStart: 0.6, loopEnd: 0.8 })` now gives 0.6–0.8 whatever the previous loop was. Before, the start could get stuck at the old end.

`setLoopStart`, `setLoopEnd`, `setParam` and `applyParams` store each value as given, clamped only to the sample length. A loop short enough to be pitched still snaps to the scale. The `loopStart`/`loopEnd` getters and the `loop-points:updated` message return those stored values. They are not the loop that plays, and the start can be greater than the end.

What plays is worked out during playback, by one rule for both trim (`startPoint`/`endPoint`) and loop points: the two points in either order, kept inside their bounds (the sample for trim, the trim range for the loop), and at least one C5 period (~1.9 ms) long. Equal points, inverted points or a loop outside the trim range no longer fall back to a larger range. Before, inverted or equal trim points played from the start point to the end of the sample, and equal loop points looped the whole trim range. You can drop any code that clamps these points against each other.

Trim points set with the start past the end now play the range backward. `setPlaybackDirection('reverse')` inverts that again, so reversed inverted trim plays forward. `cropSample` crops the same region whichever order the points are in, and the cropped sample plays forward. Inverted loop points still loop forward between the two points.
