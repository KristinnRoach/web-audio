---
'@kidlib/web-audio': minor
---

Rework the global AudioContext API. `getAudioContext` is renamed `getGlobalAudioContext`, and it now replaces a closed context instead of returning it. `ensureAudioCtx` is removed: it could wait forever for a user gesture and did not resume a context suspended again later. The context still auto-resumes on the first click, touch or key press; to wait until audio runs, call `await context.resume()` in your own gesture handler.

Add `configureGlobalAudioContext(options)`, which sets standard `AudioContextOptions` for the global context. Before first use it only stores them; afterwards, changed options replace the context and close the previous one, so nodes built on it stop. Unchanged options are a no-op. A closed global context is recreated with the same options.

`setAudioOutputDevice(deviceId, context?)` and `getCurrentOutputDeviceId(context?)` take an optional context. Before, they always targeted the global context, so apps that passed their own context to `createSamplePlayer` couldn't route its output. `setAudioOutputDevice` no longer waits for a user gesture.

`createSamplePlayer` no longer detaches the `ArrayBuffer` passed to it, so the same buffer can create more than one player.
