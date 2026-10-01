---
'@kidlib/web-audio': patch
---

Rework the global AudioContext API. `getAudioContext` is renamed `getOrCreateGlobalAudioContext`, and it now replaces a closed context instead of returning it. `ensureAudioCtx` is removed: it could wait forever for a user gesture and did not resume a context suspended again later. The context still auto-resumes on the first click, touch or key press; to wait until audio runs, call `await context.resume()` in your own gesture handler.

Add `configureGlobalAudioContext(options)`, which takes standard `AudioContextOptions` and can be called any time. If the global context exists and an option changes, it is closed and replaced, and the new context is returned so nodes can be rebuilt on it. Add `isGlobalAudioContext(context)`.

`setAudioOutputDevice(deviceId, context?)` and `getCurrentOutputDeviceId(context?)` take an optional context. Before, they always targeted the global context, so apps that passed their own context to `createSamplePlayer` couldn't route its output. `setAudioOutputDevice` no longer waits for a user gesture.

`createSamplePlayer` no longer detaches the `ArrayBuffer` passed to it, so the same buffer can create more than one player.
