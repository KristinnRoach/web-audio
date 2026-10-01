---
'@kidlib/web-audio': minor
---

Breaking: `getAudioContext` is renamed `getGlobalAudioContext`, and `ensureAudioCtx` is removed; to wait for audio, call `await context.resume()` in your own gesture handler. `SampleVoice`, `InstrumentBus`, `DattorroReverb`, `HarmonicFeedback` and `createPitchDivideEffect` (now its first argument) require an explicit context.

Add `createGlobalAudioContext(options)` for options such as `sampleRate`. It throws while a global context is open; to change options, dispose your nodes and `await` the old context's `close()` first.

`setAudioOutputDevice` and `getCurrentOutputDeviceId` take an optional context. `SamplePlayer` warns and emits `context:closed` when its context closes. `createSamplePlayer` no longer detaches the `ArrayBuffer` passed to it. Importing the package no longer creates an `AudioContext`.
