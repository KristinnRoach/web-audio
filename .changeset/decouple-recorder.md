---
'@kidlib/web-audio': minor
---

Decouple `Recorder` from `SamplePlayer`. `record:stop` now carries the recorded `buffer`, so auto-stopped takes reach consumers without a destination.

Breaking: remove `Recorder.connect()`, `Recorder.disconnect()`, `Recorder.destination`, and the `SampleLoader` type. `record:armed` and `record:start` no longer include `destination`. Replace `recorder.connect(player)` with:

```ts
recorder.onMessage('record:stop', ({ buffer }) => player.loadAudio(buffer));
```
