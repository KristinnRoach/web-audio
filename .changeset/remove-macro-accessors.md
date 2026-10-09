---
'@kidlib/web-audio': patch
---

Remove `SamplePlayer.getMacro()` and `SamplePlayer.getMacrosAudioParam()`. The loop AudioParams remain available through `getAudioParam('loopStart' | 'loopEnd')`.
