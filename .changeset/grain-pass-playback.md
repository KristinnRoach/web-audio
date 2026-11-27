---
'@kidlib/web-audio': minor
---

SamplePlayer plays every note as a sequence of passes, with the same fade at every edge. A one-shot now fades out at its trim end instead of cutting, and `voice:ended` arrives after that fade. Pass ends are shrink only: pulling trim in, or shortening the loop, is heard at once, while extending trim or moving the loop is heard from the next pass. Turning looping off lets the current loop pass finish, then plays on to the trim end.
