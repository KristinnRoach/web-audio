---
"@kidlib/web-audio": patch
---

`trimAudioBuffer` fade options

`fadeMs` is now a required `{ in, out }`: milliseconds, `"default"` for the
shortest fade that hides a cut at the buffer's sample rate, or `0` to skip that
side. Replaces `PreProcessOptions.fadeInOutMs`. Neither symbol is exported from
the package root.
