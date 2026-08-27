---
"@kidlib/web-audio": minor
---

`tuningOffset` on `setScale` now shifts the allowed periods upward in pitch for
positive values. It previously shifted them down, opposite to every other semitone
value in the package. It is also preserved across `setRootNote`, along with the octave range,
`normalize`, and `snapToZeroCrossings`, which were all silently reset to defaults.

Breaking for callers passing a nonzero `tuningOffset`: negate it to keep the old
result.
