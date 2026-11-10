---
'@kidlib/web-audio': minor
---

Remove `drive` and `clipping` from `samplerParams` to avoid overriding the distortion macro in parameter snapshots; `SamplePlayer.setDrive()` and `setClippingMacro()` remain available.
