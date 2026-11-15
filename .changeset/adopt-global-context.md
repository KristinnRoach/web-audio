---
'@kidlib/web-audio': minor
---

Add `setGlobalAudioContext(context)`, which makes an existing `AudioContext` the global one, so the library can share a context with Tone.js or your own graph.
