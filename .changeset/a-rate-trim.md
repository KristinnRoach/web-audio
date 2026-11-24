---
'@kidlib/web-audio': minor
---

Trim and loop range simplification:

- Trim is independent of loop points: loop points never move trim, and inverted trim points (`trimStart > trimEnd`) reverse playback (consistent with inverted loop points).
- Both pitch and time loops stay within trim (a keytracked time loop can still end in silence past it). The loop type comes from the requested length; trim no longer turns one into the other. A pitch loop keeps its quantized length as long as it fits in trim, shifting its position inside trim instead of clipping; a time loop clamps to trim and loops all of trim when too little of it is inside.
- Moving trim past the playhead fades out instead of clicking, and moving trim over a sounding pitch loop no longer clicks.
- Interpolation and loop crossfades can read a few milliseconds of audio outside trim, and a pitch loop pushed by a trim move sounds at its old place for up to 20 ms.
- Trim points are no longer rounded to whole samples. `trimStart` and `trimEnd` are a-rate, read at a block's first audible frame, so a note scheduled on a trim change starts at the new trim start.
