---
'@kidlib/web-audio': minor
---

Decouple `Recorder` from `SamplePlayer`. `record:stop` now carries the recorded `buffer`, so auto-stopped takes reach consumers without a destination.

Breaking: remove `Recorder.connect()`, `Recorder.disconnect()`, `Recorder.destination`, and the `SampleLoader` type. `record:armed` and `record:start` no longer include `destination`. Replace `recorder.connect(player)` with:

```ts
recorder.onMessage('record:stop', ({ buffer }) => player.loadAudio(buffer));
```

Recorder API cleanups:

- `createAudioRecorder()` returns the `Recorder` directly instead of a promise. Existing `await` calls keep working.
- `start()` rejects with a `RangeError` when `startThreshold` is outside -60..0, before acquiring input. It previously resolved, warned, and never armed. The range is now inclusive, so the -60 display-capture default arms.
- `onMessage()` is typed per event, so `record:stop` handlers get `buffer: AudioBuffer` and `state-change` handlers get `state: AudioRecorderState`. Unknown event names are a type error. `AudioRecorderState` and `RecorderEvents` are exported.
