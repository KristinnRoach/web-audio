---
'@kidlib/web-audio': minor
---

Remove unfinished multiple-source playback and unused sampler tempo sync.

- `audio` and `loadAudio()` accept one input; `loadAudio()` returns `AudioBuffer | null`. Use `audiobuffer` instead of the removed `samples` getter. `MAX_SAMPLES` is removed.
- Use `SampleVoice.loadBuffer()` and `SampleVoicePool.setBuffer()` in place of `loadAudioData()` and `setAudioData()`; layer independent voices for multiple sources.
- Remove `setTempo()`, `syncLoopToTempo()`, the `tempo` getter/parameter and associated messages.
- Add output regressions and an opt-in 16-voice timing baseline. The tag `sample-player-before-cleanup` preserves the removed implementations.
