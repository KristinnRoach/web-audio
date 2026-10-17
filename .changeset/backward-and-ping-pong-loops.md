---
'@kidlib/web-audio': minor
---

Loop modes: forward, backward and ping-pong. Loop points set in reverse order (start after end) now make a backward loop: the voice plays through the loop once, then cycles it backward. Previously they looped forward over the same region. `SamplePlayer.setLoopPingPong(true)` makes loops turn around at both edges, whatever the point order; a short pitched loop sounds an octave lower in ping-pong. Both are relative to the voice's direction, so a reverse voice with inverted loop points cycles forward. When the loop runs out of passes or is switched off, the voice plays on in its own direction. Duration preservation is inactive while a loop runs backward or ping-pong. `loop:range` reports the mode as `loopMode` (`'forward' | 'backward' | 'pingPong'`), relative to the voice's direction, whether or not looping is enabled.
