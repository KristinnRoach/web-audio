---
"@kidlib/web-audio": patch
---

setLpfCutoff now targets both filters by default and setHpfCutoff the post-FX one; both previously defaulted to pre-FX only. Voice and bus filters share one Q and one cutoff smoothing constant, the voice chain puts the LPF last, and filter keytracking is off by default.

Cutoff glide timing is fixed: `glideTime` is a ramp duration, but it was passed straight to `setTargetAtTime` as an exponential time constant, so a glide took roughly 3x as long as requested. It is now divided by 3. The direct cutoff setters also honour `options.cancelPrevious` instead of always clearing scheduled automation. `HarmonicFeedback.setDelay` and `setDelayMultiplier` had the same gap: a negative glide time slipped past their `=== 0` guard.
