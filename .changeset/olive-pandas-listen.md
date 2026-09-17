---
'@kidlib/web-audio': patch
---

Envelope edits now reach a running envelope on its next loop boundary instead of waiting for the next trigger. `EnvelopeRuntime.nextCycleTime()` reports that boundary, or null when the run is not looping and has no seam to hand over on. Non-looping runs keep their shape until the next trigger.
