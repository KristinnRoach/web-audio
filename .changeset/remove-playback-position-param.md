---
'@kidlib/web-audio': patch
---

Remove the unused `playbackPosition` AudioParam from sample voices. Use `enablePositionTracking(true)` and the `voice:position` message for the playhead.
