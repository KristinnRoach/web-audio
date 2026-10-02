---
'@kidlib/web-audio': minor
---

Breaking: `SamplePlayer` loads audio through one method and uses "sample" instead of "layer".

- `loadSample(buffer, options)` and `loadLayers(buffers, options)` → `loadAudio(audio, options)`. `audio` is one `ArrayBuffer | AudioBuffer` or an array of them, and the result is always an array (or `null`).
- `SampleLoader` now requires `loadAudio` instead of `loadSample`. The new `AudioInput` type is `ArrayBuffer | AudioBuffer`.
- `layers` getter → `samples`
- `SamplePlayer.MAX_LAYERS` → `SamplePlayer.MAX_SAMPLES`
- `SamplePlayerOptions.audioBuffer` → `audio`, which takes the same input as `loadAudio`

Breaking: `createSamplePlayer(buffer, options?)` → `createSamplePlayer(options?)`. Pass the audio as `{ audio }`. Calling it without audio now returns a player with nothing loaded instead of throwing; load some later with `loadAudio`.

A `SamplePlayer` whose `init()` fails, for example on an undecodable sample, now disposes itself instead of staying registered with its context listener attached.
