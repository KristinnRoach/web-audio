---
"@kidlib/web-audio": patch
---

setLpfCutoff now targets both filters by default and setHpfCutoff the post-FX one; both previously defaulted to pre-FX only. Voice and bus filters share one Q and one cutoff smoothing constant, the voice chain puts the LPF last, and filter keytracking is off by default.
