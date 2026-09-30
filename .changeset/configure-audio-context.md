---
'@kidlib/web-audio': patch
---

Add `configureAudioContext({ sampleRate, latencyHint })` to set the config the global AudioContext is created with. Call it before anything touches audio; it throws if the context already exists at a different sample rate.

`setAudioOutputDevice(deviceId, context?)` and `getCurrentOutputDeviceId(context?)` take an optional context. Before, they always targeted the global context, so apps that passed their own context to `createSamplePlayer` couldn't route its output. Existing calls are unchanged.
