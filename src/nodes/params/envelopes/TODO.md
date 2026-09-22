# Envelopes — deferred

Temporary. Fold into issues or delete once the module settles.

## Investigate reported loop drift

Kiddi hears the loop walking out of phase after a few cycles. The scheduling grid is
ruled out: measured 1.1e-12 s of accumulated error over 3001 cycles of a 7 ms envelope,
about 5e-8 of one sample at 48 kHz. `test/Envelope.test.ts` now pins that. Onset "after a
few cycles" rules out float error anyway. Two candidates, both fast-onset:

- **Refill starvation.** `LOOKAHEAD_SECONDS = 1` against a 50 ms `setInterval`. A
  backgrounded tab throttles the timer to ~1 s while the audio clock keeps running, so a
  cycle can be scheduled at or past its own start time and Web Audio applies it
  immediately. Probe: advance the clock in 1 s steps while firing the timer once per step,
  and assert every cycle is scheduled strictly ahead of `clock.currentTime`.
- **`timeScale` composition against the sample rate.** `SampleVoice.#timeScale` composes
  `config.timeScale * playbackRate` for the envelopes that follow the rate. If the
  sample's playback rate is applied on a different grid than the envelope's, the two walk
  apart at a rate proportional to the rate error, which would be audible within a few
  cycles. Probe: drive a loop and a sample from one trigger at a non-integer rate and
  compare cycle boundaries against buffer wraps.

Ear test before landing either fix.

## Known, accepted

- `Math.max(grid, cycleEnd)` in `Envelope.trigger` is a ratchet: it only ever pushes a
  cycle later, never back, so its error accumulates instead of cancelling. Bounded at
  picoseconds. Leave it; the guard is what stops a cycle opening before the previous one
  closes, which is audible.

## Structure

- `releaseStartTime`, `setReleasePoint`, `setSustainPoint` have no callers outside tests.
  Delete unless the editor UI lands.
- `EnvelopeConfig` and its two helpers now live in `envelope-config.ts`, so preset data
  no longer reaches through the runtime class module for a type.
- `updatePoint` and `setDuration` now return `EnvelopePoint[]`, so a caller rebuilding a
  shape writes `{ ...shape, points: updatePoint(shape.points, ...) }` and gets a new shape
  object even when the edit was rejected. The old versions returned the same shape by
  identity, which memoised editors can use. Revisit if the editor UI wants it back;
  identity at the points array is still preserved.
