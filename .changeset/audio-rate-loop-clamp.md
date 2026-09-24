---
'@kidlib/web-audio': patch
---

Audio-rate loops (61 ms or shorter) now keep their length at the trim edges. The playback range snaps to zero crossings, and clamping a loop into it shortened the loop, which detuned it off its snapped pitch or fell back to looping the whole range. Such a loop is now shifted into the range instead, as long as it fits.
