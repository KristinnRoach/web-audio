---
'@kidlib/web-audio': minor
---

Breaking: `loadLayers` and `loadSample` drop the unused `modSampleRate` parameter; preprocess options are now the second argument. Replace `loadLayers(buffers, undefined, options)` with `loadLayers(buffers, options)`.

`AudioBuffer` layers whose sample rate differs from the player's context are now resampled to match, instead of throwing `RangeError` (layer 0) or being skipped (other layers). Encoded `ArrayBuffer` input was already converted by `decodeAudioData`, so both input types now load at the context's rate.
