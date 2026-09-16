---
"@kidlib/web-audio": patch
---

Retune the bus compressor and limiter defaults: the old release times were short enough to modulate the waveform rather than its level, which pumped and distorted on low content. Removes polyphony gain compensation, so chords now sit louder relative to single notes.
