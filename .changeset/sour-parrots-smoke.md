---
"@kidlib/web-audio": patch
---

Retune the instrument bus compressor and limiter defaults.

Release on these nodes is the time to recover 10 dB, so a release shorter than a few cycles of the lowest content moves the gain envelope within the waveform itself, modulating it rather than its level. The limiter shipped at 10 ms, roughly half a cycle at 50 Hz, which is the "ugly clipping" the old code comment flagged; it is now 0.1 s with a 2 dB knee and 2 ms attack. The compressor shipped at 50 ms release and a 3 ms attack, fast enough to pump on bass and too fast to act as bus glue; it is now 0.25 s release and 10 ms attack, with a softer 12 dB knee.

The limiter also drops from -1 to -2 dBFS. `DynamicsCompressorNode` has no lookahead, so the first transient always overshoots and the old ceiling left no room for it.

Removes polyphony gain compensation. Voices were ducked by active voice count via `1 / (1 + log10(n) * 0.4)`, which takes 1.87 dB off a four-note chord while the chord's own summing raises it 6-11 dB depending on how coherent the voices are. Below the threshold of noticing. Voice count is also a poor proxy for level: quiet and loud voices ducked identically, and the correct amount depends on coherence, which varies with the material. The bus compressor measures the actual signal.

Chords are now louder relative to single notes than in 0.4.0, and the bus dynamics no longer pump on fast passages.
