---
'@kidlib/web-audio': minor
---

Remove the `note:off` event from `SamplePlayer`; listen to processor-driven `voice:releasing` and `voice:stopped` events instead.
