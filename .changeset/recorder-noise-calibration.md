---
'@kidlib/web-audio': minor
---

Add room-noise calibration and metering before arming to `Recorder`.

- `measureNoiseFloor({ input?, durationMs = 800, marginDb = 12 })` listens to the input and resolves `{ noiseFloorDb, startThresholdDb, stopThresholdDb }`, or `null` if cancelled. The floor is the 95th percentile of the sampled peaks; the suggested start threshold is `marginDb` above it, kept within -60..0 dB. Nothing is applied automatically: pass the result to `arm()`.
- `monitor({ input? })` opens input and emits `record:level` without arming, in the new `MONITORING` state. `start()`/`arm()` while monitoring reuse the open input unless they name another. `cancel()` or `stop()` ends monitoring without `record:cancelled`. `isMonitoring` is added.
- `stopOnSilence` only counts silence once the take has had sound. `start({ stopOnSilence: true })` in a quiet room now keeps recording until something is played, where it used to deliver a silent take after the wait.
- `stopOnSilence: { trim: true }` cuts the silence wait off the end of a take that stopped on silence.
- `record:level` reports `startThresholdDb: null` while monitoring, so its type is now `number | null`.
- `RecorderMonitorOptions`, `RecorderNoiseOptions` and `RecorderNoiseMeasurement` are exported.
