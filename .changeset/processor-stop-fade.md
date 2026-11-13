---
'@kidlib/web-audio': patch
---

Reduce clicks at sample note starts and stops. Scheduled stops stay accurate when the main thread is busy, and released voices become available as soon as their amp tail and de-click fade finish.
