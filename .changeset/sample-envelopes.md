---
'@kidlib/web-audio': minor
---

Add a pan envelope through `getEnvelope('pan')` and `updateEnvelope('pan', config)`, with shape values from -1 (left) to 1 (right). Loop-synced envelopes now stay aligned with sample loops when the main thread is busy. Live value edits reshape the current segment or held sustain; timing edits apply from the next point.

Amp envelope `depth` now blends from unity gain at 0 to the full shape at 1. If the app used `depth` to control loudness, use `setVolume()` instead. `envelopeIds` now includes `'pan'` and returns a readonly array; copy it before modifying it.
