---
'@kidlib/web-audio': minor
---

Make `SamplePlayer.outBus` private. Use the player methods `setDistortionMacro`, `setDrive`, `setClippingMacro`, `setDelayTime`, and `setDelayFeedback` for the corresponding effects controls. Existing sampler parameter descriptors continue to work unchanged.
