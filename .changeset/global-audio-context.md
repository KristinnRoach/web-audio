---
'@kidlib/web-audio': minor
---

Breaking: `getAudioContext` is renamed `getGlobalAudioContext`, and `ensureAudioCtx` is removed; to wait for audio, call `await context.resume()` in your own gesture handler. The global context no longer sets a `sampleRate`, so it runs at the output device's native rate. `DEFAULT.audioConfig.sampleRate`, now used only for offline contexts, is 44100 instead of 48000.

Add `createGlobalAudioContext(options)` for options such as `sampleRate`. It throws while a global context is open; to change options, dispose your nodes and `await` the old context's `close()` first.

`setAudioOutputDevice` and `getCurrentOutputDeviceId` take an optional context. `SamplePlayer` warns and emits `context:closed` when its context closes. `createSamplePlayer` no longer detaches the `ArrayBuffer` passed to it. Importing the package no longer creates an `AudioContext`.
