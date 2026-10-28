---
'@kidlib/web-audio': patch
---

Add `durationRatio` to `SamplePlayer.updateEnvelope`: `1` uses the loaded sample's full duration, `0.5` uses half, and positive values above `1` extend beyond it. The existing `duration` input remains in seconds. Ratios require a loaded sample and cannot be combined with `duration`.

Assign resized envelopes' final endpoint directly to avoid rounding through the scale factor.
