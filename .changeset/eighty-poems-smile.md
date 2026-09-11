---
"@kidlib/web-audio": minor
---

Add the `@kidlib/web-audio/debug` entry point, exporting `monitorLevels`. `SamplePlayer`, `InstrumentBus`, `SampleVoicePool` and `SampleVoice` gain a `getGainStages()` method reporting per-stage peak, RMS and clip counts while audio runs.

Removes `LevelMonitor` and the `startLevelMonitoring`, `stopLevelMonitoring` and `logLevels` methods. They rewired the graph to insert analysers and broke the signal path on any graph not wired straight to `ctx.destination`. Use `monitorLevels` instead.

`clippingThreshold` now has a non-zero minimum; zero produced NaN.
