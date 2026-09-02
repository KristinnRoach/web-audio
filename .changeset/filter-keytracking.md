---
"@kidlib/web-audio": patch
---

Fix filter keytracking, which moved cutoffs by the wrong amount. Filter cutoffs now match their configured value at unity playback rate and track pitch from there, so existing patches sound roughly an octave brighter on the HPF. LPF keytracking is on by default and no longer overwritten by the filter envelope.
