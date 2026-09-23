---
'@kidlib/web-audio': patch
---

`EnvelopeConfig` takes an optional `playbackRateSync` flag, so sync is read back by `getEnvelopeConfig`, carried in `envelope:changed` and restored by `applyEnvelopeConfig`. `setEnvelopeSync(id, sync)` now applies the current config with the flag changed, so it also emits `envelope:changed`, and `resetEnvelope`/`resetEnvelopes` turn sync off.
