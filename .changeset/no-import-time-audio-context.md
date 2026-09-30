---
'@kidlib/web-audio': patch
---

Importing the package no longer creates and closes a throwaway `AudioContext`. It came from an unused internal environment-detection util, which is now removed.
