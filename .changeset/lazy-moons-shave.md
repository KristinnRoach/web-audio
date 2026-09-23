---
'@kidlib/web-audio': patch
---

- `SamplePlayer.setLpfCutoff` now targets both pre- and post-FX filters by default; `setHpfCutoff` targets post-FX. Pass `'pre'` explicitly to retain the previous defaults.
- Filter keytracking is off by default, and voice and bus filters use the same Q and cutoff smoothing.
- Cutoff `glideTime` now represents ramp duration, and cutoff setters honor `cancelPrevious: false` to preserve scheduled automation.
- Added the root `DEFAULT` export for shared library defaults.
