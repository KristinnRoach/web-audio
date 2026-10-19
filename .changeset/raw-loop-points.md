---
'@kidlib/web-audio': minor
---

Loop and trim points no longer clamp against each other.

- Setters store values as given, clamped only to the sample length. Getters and `loop-points:updated` return the raw values, and start can be past end. Drop any app-side clamping.
- Playback accepts either order. Inverted trim plays backward and inverted loop points loop backward. `cropSample` accepts either order.
