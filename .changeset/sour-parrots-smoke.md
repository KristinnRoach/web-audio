---
"@kidlib/web-audio": patch
---

Retune the instrument bus compressor and limiter defaults. The compressor's 20 ms release moved the gain envelope within a single cycle of low-frequency content, causing pumping and intermodulation; release is now 0.25 s and attack 10 ms rather than 3 ms. The limiter gets slightly more headroom for overshoot, since `DynamicsCompressorNode` has no lookahead.

Remove polyphony gain compensation. Voices were ducked by active voice count, which at the shipped sensitivity took about 1.87 dB off a 4-note chord while the chord's own summing raised it 4-6 dB — below the threshold of noticing. Voice count is a poor proxy for level anyway: quiet and loud voices ducked identically, and correlated voices sum at +6 dB/doubling while the formula assumed +3. The bus compressor and limiter measure the actual signal.

Chords are now louder relative to single notes than in 0.4.0, and the bus compressor no longer pumps on fast passages.
