---
'@kidlib/web-audio': patch
---

- `SamplePlayer.setLpfCutoff` now targets both pre- and post-FX filters by default; `setHpfCutoff` targets post-FX. Pass `'pre'` explicitly to retain the previous defaults.
- Filter keytracking is off by default, and voice and bus filters use the same Q and cutoff smoothing.
- Cutoff `glideTime` now represents ramp duration, and cutoff setters honor `cancelPrevious: false` to preserve scheduled automation.
- The default voice chain places the LPF after feedback (`am -> hpf -> feedback -> lpf`).
- Positive cutoff `glideTime` values are converted to `glideTime / 3`; omitted, non-positive, and non-finite values use default smoothing.
- `HarmonicFeedback.setDelay` and `setDelayMultiplier` treat non-positive and non-finite glide times as immediate changes.
- Added the root `DEFAULT` export for shared library defaults.
