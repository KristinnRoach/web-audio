---
'@kidlib/web-audio': patch
---

`voice:position` is no longer clamped to 1, so the playhead follows a keytracked loop past the buffer end.
