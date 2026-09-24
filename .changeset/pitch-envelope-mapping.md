---
'@kidlib/web-audio': patch
---

Pitch envelope values are now bipolar semitone offsets: `-1..1` spans one octave down to one octave up, and `0` is unison (previously the value multiplied the note's playback rate, so `1` was unison and the envelope could only bend down). The default pitch shape is flat at `0`. Non-step curves play exponentially in rate, so bends are linear in pitch.

SamplePlayer setLpfCutoff defaults to "pre".
