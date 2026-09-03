---
"@kidlib/web-audio": patch
---

Rename pitch-detection `confidence` to `periodicity`

`PreProcessOptions.tune.minConfidence` becomes `minPeriodicity`, and the
`periodicity` it gates is reported on `PreProcessResults.detectedPitch`. Both
reach consumers through the preprocess options on `loadSample` and
`loadLayers`. The value is unchanged; only the name is.

The old name implied "probability the frequency is correct", which is the
opposite of what it measures: a chord scores 0.997 at its common period while
a correctly detected clean note scores 0.969. It measures whether the input is
pitched at all - noise and silence score near 0, anything pitched above 0.9 -
so it is a reliable gate for rejecting noise, not for trusting the frequency.
