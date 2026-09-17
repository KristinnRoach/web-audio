---
"@kidlib/web-audio": patch
---

Turning an envelope's loop on mid-note now takes effect immediately. The run carries on from the point it has reached, plays out to the end of the shape, and loops from there; previously the edit waited for the next trigger, since a non-looping run has no cycle boundary to hand over on. `EnvelopeRuntime.currentPoint()` reports that point, and a trigger can open mid-shape with the new `fromPoint` option.
