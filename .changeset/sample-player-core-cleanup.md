---
'@kidlib/web-audio': minor
---

Remove unfinished multiple-source playback and unused sampler tempo sync.

- `audio` and `loadAudio()` accept one input; `loadAudio()` returns `AudioBuffer | null`. Use `audiobuffer` instead of the removed `samples` getter. `MAX_SAMPLES` is removed.
- Use `SampleVoice.loadBuffer()` in place of `SampleVoice.loadAudioData()`; layer independent voices for multiple sources.
- Remove `setTempo()`, `syncLoopToTempo()`, the `tempo` getter/parameter and associated messages.
