---
'@kidlib/web-audio': minor
---

Add `renderOffline(setup, { duration })`, which renders what `setup` builds to an `AudioBuffer` faster than real time. Notes and settings sent from `setup` reach the audio thread before the first frame.
