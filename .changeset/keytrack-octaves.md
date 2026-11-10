---
'@kidlib/web-audio': patch
---

Loop keytrack now scales loop duration exponentially with playback rate. Amounts 0 and 1 sound the same as before; amounts in between change.
