---
'@kidlib/web-audio': patch
---

Importing the package no longer creates and closes a throwaway `AudioContext` to detect AudioWorklet support. It checks `BaseAudioContext.prototype` instead, so there's no extra audio thread or autoplay warning on load.
