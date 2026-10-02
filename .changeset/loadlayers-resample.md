---
'@kidlib/web-audio': minor
---

Breaking: the sample-loading methods drop the unused `modSampleRate` parameter; preprocess options are now the second argument, as in `loadAudio(audio, options)`.

`AudioBuffer` samples whose sample rate differs from the player's context are now resampled to match, instead of throwing `RangeError` (sample 0) or being skipped (other samples). Encoded `ArrayBuffer` input was already converted by `decodeAudioData`, so both input types now load at the context's rate.
