---
'@kidlib/web-audio': patch
---

Fix sampler loop-wrap de-click: corrects each output channel evenly, measures the step at any playback rate, and no longer carries into the next note. Preserve smoothing during simultaneous loop moves and across keytracked silent tails. Keep de-click timing consistent across sample rates, with an internal shared duration multiplier for tuning.
