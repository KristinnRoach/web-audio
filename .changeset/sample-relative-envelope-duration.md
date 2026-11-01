---
'@kidlib/web-audio': patch
---

Add `durationRatio` to `SamplePlayer.updateEnvelope`: `1` uses the loaded sample's full duration, `0.5` uses half, and values above `1` extend beyond it. Requires a loaded sample and cannot be combined with `duration`.
