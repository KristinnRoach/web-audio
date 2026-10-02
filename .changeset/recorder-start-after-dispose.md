---
'@kidlib/web-audio': patch
---

`Recorder.start()` no longer arms or records when `dispose()` runs while it is still acquiring its input. The acquired stream is released instead. `start()` on a disposed recorder does nothing.
