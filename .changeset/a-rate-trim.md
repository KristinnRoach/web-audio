---
'@kidlib/web-audio': minor
---

Trim and loops are independent:

- A pitch loop keeps its place and length wherever trim is. Moving trim over it, or moving both together, no longer changes its pitch or clicks. It can be outside trim: start from loop plays it directly, otherwise the note ends at the trim end.
- A loop is a pitch loop or a time loop by its requested length; trim no longer turns one into the other. A time loop stays inside trim, and loops all of trim when too little of it is inside.
- If trim start passes trim end, the two swap. Use the playback direction control to reverse playback. `trim:range` no longer has `inverted`.
- Turning looping off outside trim, or moving trim past the playhead, fades out instead of clicking.
- Interpolation and loop crossfades can read a few milliseconds of audio outside trim.
- Trim points are no longer rounded to whole samples. `trimStart` and `trimEnd` are a-rate, read at a block's first audible frame, so a note scheduled on a trim change starts at the new trim start.
