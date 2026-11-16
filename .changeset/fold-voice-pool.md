---
'@kidlib/web-audio': patch
---

`SamplePlayer` sends each setting to its audio processor once instead of once per voice, so it posts far fewer port messages. Sound and API are unchanged.
