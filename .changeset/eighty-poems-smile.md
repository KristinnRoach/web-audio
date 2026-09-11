---
"@kidlib/web-audio": patch
---

Add `@kidlib/web-audio/debug` with `monitorLevels`, plus `getGainStages()` on `SamplePlayer`, `InstrumentBus`, `SampleVoicePool` and `SampleVoice` for per-stage peak, RMS and clip counts while audio runs.

Removes `LevelMonitor` and the `startLevelMonitoring` / `stopLevelMonitoring` / `logLevels` methods that delegated to it. It inserted analysers by disconnecting the monitored node and reconnecting it to a hardcoded guess at its destination, which silently broke the signal path on any graph not wired straight to `ctx.destination`.
