---
'@kidlib/web-audio': minor
---

Breaking: `getAudioContext` is renamed `getGlobalAudioContext`, and `ensureAudioCtx` is removed; to wait for audio, call `await context.resume()` in your own gesture handler. The global context no longer sets a `sampleRate`, so it runs at the output device's native rate. `DEFAULT.audioConfig`, `DEFAULT.DEFAULT_SAMPLE_RATE` and `DEFAULT.DEFAULT_NUMBER_OF_CHANNELS` are removed.

Add `createGlobalAudioContext(options)` for options such as `sampleRate`. It throws while a global context is open; to change options, dispose your nodes and `await` the old context's `close()` first.

Breaking: `new SamplePlayer(options)` requires `options.context` and throws without it; it no longer falls back to the global context. `createSamplePlayer` still uses the global context when none is given.

`createSamplePlayer` no longer waits for a user gesture to resume the context, so it can resolve with the context still `suspended`. Audio starts on the next click, touch or key press; `await context.resume()` in a gesture handler if you need it running first.

`setAudioOutputDevice` and `getCurrentOutputDeviceId` take an optional context. `SamplePlayer` warns and emits `context:closed` when its context closes. `createSamplePlayer` no longer detaches the `ArrayBuffer` passed to it. Importing the package no longer creates an `AudioContext`.
