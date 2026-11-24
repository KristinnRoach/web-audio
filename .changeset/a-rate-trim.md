---
'@kidlib/web-audio': minor
---

Trim no longer cuts a pitch loop:

- A pitch loop keeps its place and length wherever trim is, and trim widens to contain it while looping. Moving trim over a pitch loop, or moving both together, no longer changes its pitch or clicks. Time loops still stay inside trim.
- Interpolation and loop crossfades can read a few milliseconds of audio outside trim.
- Trim points are no longer rounded to whole samples. `trimStart` and `trimEnd` are a-rate, read at a block's first audible frame, so a note scheduled on a trim change starts at the new trim start.
