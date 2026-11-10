---
'@kidlib/web-audio': patch
---

Loop keytrack now tracks exponentially, in octaves of the played note. Amounts 0 and 1 sound the same as before; amounts in between change. Pitch modulation (pitch envelope, pitch LFO, detune) no longer changes the keytracked loop length.
