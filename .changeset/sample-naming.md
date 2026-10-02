---
'@kidlib/web-audio': minor
---

Breaking: `SamplePlayer` uses "sample" instead of "layer" throughout its public API.

- `loadLayers(buffers, options)` → `loadSamples(buffers, options)`
- `layers` getter → `samples`
- `SamplePlayer.MAX_LAYERS` → `SamplePlayer.MAX_SAMPLES`
- `SamplePlayerOptions.audioBuffer` → `sample`, which now also accepts an encoded `ArrayBuffer`

Breaking: `createSamplePlayer(buffer, options?)` → `createSamplePlayer(options?)`. Pass the sample as `{ sample }`. Calling it without a sample now returns a player with nothing loaded instead of throwing; load one later with `loadSample`.

A `SamplePlayer` whose `init()` fails, for example on an undecodable sample, now disposes itself instead of staying registered with its context listener attached.
