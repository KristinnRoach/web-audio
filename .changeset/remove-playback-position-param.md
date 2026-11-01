---
'@kidlib/web-audio': patch
---

Remove the unused `playbackPosition` AudioParam from sample voices. Nothing read it, and each `voice:position` report added an automation event to it. Use `enablePositionTracking(true)` and the `voice:position` message for the playhead.
