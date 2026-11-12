---
'@kidlib/web-audio': minor
---

Decouple `Recorder` from `SamplePlayer` and rework its start/stop controls. `record:stop` carries the recorded `buffer`, so auto-stopped takes reach consumers without a destination.

Breaking: remove `Recorder.connect()`, `Recorder.disconnect()`, `Recorder.destination`, and the `SampleLoader` type. Replace `recorder.connect(player)` with:

```ts
recorder.onMessage('record:stop', ({ buffer }) => player.loadAudio(buffer));
```

Breaking: `start()` records immediately. Waiting for sound moves to `arm()`, and `forceStart()` is gone (call `start()` while armed). The `useThreshold`, `startThreshold`, `autoStop`, `stopThreshold` and `silenceTimeoutMs` options are replaced:

| Before                                                                  | After                                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `start()` (threshold on by default)                                     | `arm()`                                                          |
| `start({ useThreshold: false })`                                        | `start()`                                                        |
| `start({ startThreshold: -40 })`                                        | `arm({ startThresholdDb: -40 })`                                 |
| `start({ autoStop: true, stopThreshold: -50, silenceTimeoutMs: 1000 })` | `arm({ stopOnSilence: { thresholdDb: -50, durationMs: 1000 } })` |
| `forceStart()`                                                          | `start()` while armed                                            |

Other changes:

- `stop()` resolves `AudioBuffer | null`. It resolves `null` when idle, and when armed or still requesting input, which cancels the take. Calls while finalizing share one result. Capture and decode failures still reject and emit `record:error`.
- `cancel()` also discards a take that is requesting input or finalizing. Pending startup calls settle without waiting for permission, and a pending `stop()` resolves `null` without waiting for decoding. Late input is released.
- Repeated `start()`/`arm()` calls share a pending startup and leave an active take alone. `start()` after `dispose()` rejects.
- States are `IDLE`, `REQUESTING_INPUT`, `ARMED`, `RECORDING` and `FINALIZING`; `STOPPED` is gone, a finished take returns to `IDLE`. `state-change` fires on every transition with `{ state, previousState }`, no longer `event`. `record:stopping` is removed, use `state-change` to `FINALIZING`. `record:armed` reports `thresholdDb` instead of `threshold`. New `record:error` reports failures, including ones after `start()` resolved.
- `record:stop` fires once per take, after the take's input is released, so a handler can start the next take.
- New `{ type: 'stream', stream }` input records a caller-supplied `MediaStream` without stopping its tracks. Microphone input takes `constraints`, merged over the music-friendly defaults (echo cancellation, gain control and noise suppression off).
- The format is no longer forced to `audio/webm`; the browser picks one unless `mediaRecorderOptions.mimeType` is set, which is checked with `MediaRecorder.isTypeSupported()`.
- `start()`/`arm()` reject before acquiring input for non-finite or positive dB values, a non-positive or non-finite `durationMs`, `stopOnSilence.thresholdDb` at or above `startThresholdDb`, an unsupported `mimeType`, an `AudioNode` from another context, or a stream without a live audio track. Display capture without an audio track rejects and releases the capture.
- `createAudioRecorder()` returns the `Recorder` directly instead of a promise. Existing `await` calls keep working.
- `onMessage()` is typed per event. `AudioRecorderState`, `RecorderEvents` and `RecorderArmOptions` are exported.
- `stopOnSilence: true` (or `{}`) uses a stop threshold 6 dB below the start threshold and waits for 600 ms of continuous silence. Object options can override either setting. Silence stopping remains opt-in; the wait is included in the buffer and resets when sound returns.
- `metering: true` enables typed `record:level` events with sampled `peakDb`, `rmsDb`, and the effective start/stop thresholds. Levels are dBFS with `-Infinity` for digital silence, reported approximately every 20 ms while armed or recording using the existing analyser. Timer throttling can delay updates in background tabs.
- `setStartThresholdDb()` adjusts a pending/armed take without reacquiring input. Derived stop thresholds follow; explicit stop thresholds stay fixed and must remain lower. It does not change future takes. Room-noise calibration and adaptive defaults are tracked in https://github.com/KristinnRoach/web-audio/issues/167.

Recording still goes through `MediaRecorder` and a decode, so lossless capture is not guaranteed and the initial attack before a trigger can be missed. Tracked in https://github.com/KristinnRoach/web-audio/issues/166.
