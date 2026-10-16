---
'@kidlib/web-audio': patch
---

Reverse playback reads the sample at the playhead, as forward does. It previously read one sample behind, so reverse now plays the exact samples forward plays, including the trim start. A reverse voice whose trim starts at 0 no longer restarts from the trim end when the playhead lands exactly on 0.
