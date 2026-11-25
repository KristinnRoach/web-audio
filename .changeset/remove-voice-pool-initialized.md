---
'@kidlib/web-audio': minor
---

Remove the `voice-pool:initialized` event from `SamplePlayer`; listen to `sample-player:initialized` instead (note that `sample-player:initialized` does not include the `voiceCount` payload field).
