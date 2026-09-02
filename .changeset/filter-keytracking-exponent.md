---
"@kidlib/web-audio": minor
---

Fix filter keytracking, which applied the keytrack amount as a multiplier where it needed an exponent. Cutoffs now follow `baseHz * playbackRate ** amount`, so the amount means octaves of cutoff per octave of pitch and the cutoff equals the configured value at unity playback rate. Every voice gets roughly one octave more HPF than before at unity rate, so existing patches shift. LPF keytracking is enabled by default (0.25) and now composes with the filter envelope instead of being overwritten by it.

Adds `getKeytrackedFilterHz`, plus `clampHz` and `maxSafeHz` for clamping filter cutoffs to the safe range for a sample rate.
