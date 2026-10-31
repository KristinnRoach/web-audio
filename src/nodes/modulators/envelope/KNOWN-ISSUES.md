# Envelope follow-ups

Single backlog for envelope internals and sampler integration. Current live editing,
including switching to and from loop mode, is intentionally preserved: it works well
in the consuming app's listening sessions. These are follow-ups, not a cleanup-PR checklist.
Code observations below are not claims that every case has been reproduced audibly.

## Live edits

- **Point-quantized loop pickup.** `SampleVoice.setEnvelopeConfig` in
  `../../instruments/Sample/SampleVoice.ts` resumes from `currentPoint()`.
  Mid-segment, this can jump back to the preceding point. Preserve the held-sustain
  pickup when revisiting continuous continuation; `fromPoint` currently only supports loops.
- **Pending handover.** `Envelope.trigger` replaces its run fields immediately, even
  for a future loop boundary. Reads and a note-off before that boundary can therefore
  use the incoming run rather than the one still sounding. Repeated drag edits should
  continue targeting the same pending boundary. A boundary alone does not guarantee
  continuity if the new shape's opening value differs.
- **Sustain glide.** `Envelope.setSustainValue` only responds after sustain is reached.
  It changes the run's point immediately. Sustain-index and mid-attack
  changes remain next-trigger edits. A release or edit during the glide holds the
  glide's current value. Preserve the trigger snapshot for the release tail.
  Rescheduling the rest of the attack from the current position was tried for
  mid-attack edits and still stepped audibly.
- **Pitch envelope and disabled pitch.** The pitch envelope drives the sample worklet's
  `detune` (cents), so glide and keytracking keep `playbackRate`. `disablePitch` resets
  `playbackRate` to 1 but leaves `detune` alone, so a pitch envelope still bends a voice
  whose pitch is disabled.
- **Boundary cancel.** A loop retrigger cancels from the boundary, and
  `cancelScheduledValues(t)` removes events at `t` too, which includes the closing ramp
  of the cycle in progress. Per the Web Audio spec that ramp would be dropped mid-flight.
  Not yet heard in listening sessions; check with a browser test.

## Loop timing modes (undecided)

- **`loopRelative` and `playbackRateSync` overlap.** `loop:cycle` reports `loopSeconds` in
  buffer time; one loop lasts `loopSeconds / |rate|` in real time. With `loopRelative` on,
  `playbackRateSync` decides whether the envelope locks to real time (on) or buffer time
  (off). Off, the per-cycle retrigger cuts the shape at `1/rate` of its length above the
  root, which is hard to hear.
- **Proposal.** Rename to `loopSync`, lock to real time
  (`sampleDuration * |rate| / loopSeconds`) and ignore `playbackRateSync` under it; loop
  keytrack is then the pitch-follow control. Drop `snapScale` so `loopSync` off is plain
  seconds, which also removes the voice's use of `requestedLoopSeconds`.
- **Open.** Whether `loopSync` measures against the sample-length timeline (half-length
  shape plays twice per loop) or the whole shape (one shape per loop), and what applies
  when the sample loop is off.

## Scheduling and lifecycle

- **Writes outside the envelope.** Holds read `TrackedParam`, which only sees automation
  scheduled through it. `SampleVoice` writes the same params directly while an envelope is
  off (`#resetEnvTarget`, the amp gate); that is safe only because the envelope never reads
  while it is not running. Keep it that way, or route those writes through the wrapper.
- **Future commands.** Releasing or stopping a loop removes its refill callback
  immediately, even if the requested time is beyond the queued horizon. `stop(time)`
  pins the value the scheduled timeline has at that time.
- **Validation.** Shape, time scale, base, depth, finite scheduling timestamps, integer loop
  pickup indices, and sustain values/glides are checked before run mutation. Finite past
  times and out-of-range integer pickup indices retain their existing clamping.
- **Reported loop drift.** The cause remains unconfirmed. The existing 3,001-cycle
  grid check measured roughly 1e-12 seconds of error for a 7 ms loop, and drift heard
  after a few cycles is too fast for float error anyway. Two candidates:
  - _Refill starvation._ A backgrounded tab throttles the 50 ms refill timer to ~1 s
    while the audio clock runs on, so with a 1 s lookahead a cycle can be scheduled at
    or after its own start and Web Audio applies it immediately. Probe: advance the
    clock in 1 s steps, fire the timer once per step, and assert every cycle is
    scheduled strictly ahead of `clock.currentTime`.
  - _Time-scale composition._ `SampleVoice.#timeScale` multiplies `timeScale` by
    `playbackRate`. If the sample's rate lands on a different grid than the envelope's,
    the two walk apart in proportion to the error. Probe: drive a loop and a sample
    from one trigger at a non-integer rate and compare cycle boundaries to buffer wraps.

  Listen in the consuming app before landing either fix.

- **Accepted rounding guard.** Keep `Math.max(grid, cycleEnd)` in `Envelope.trigger`:
  it prevents an opening event preceding the previous closing ramp. Its measured
  accumulated error is tiny; do not remove it as an incidental simplification.

## Observation and callers

- `position()` wraps loops and clamps sustain, but one-shots advance beyond their end.
  It becomes null as soon as release is requested, including future release, and does
  not describe the release tail. It is not a completion signal. No envelope-specific
  browser test currently verifies position against rendered automation. When adding
  one (model on `../LFO/LFO.browser.test.ts`, run with `vp run test:browser`), assert
  first that `base + depth * interpolateAtTime(points, points[0].time + position())`
  matches `param.value` on a real `AudioContext`; every consumer inherits any
  disagreement. Then check that position tracks the real clock and wraps at loop ends.
- Keep `nextCycleTime()` until a replacement handles future starts and pickup anchors;
  position alone does not provide those. `currentPoint()` currently returns null for loops.
- `SamplePlayer` owns editable configs; `SampleVoice` still coordinates config storage,
  enable/disable, timing, retrigger inputs and cleanup. Further consolidation belongs
  with the sampler policy, without moving sampler decisions into `Envelope`.
- Post-FX/instrument-bus envelopes remain deferred. Establish the voice pattern first;
  the removed commented-out forwarding code was never active integration.
- Point-edit helpers preserve points-array identity on rejected edits, but rebuilding
  `{ ...shape, points }` creates a new shape identity. Revisit only if an editor needs it.
- Observer callbacks and release-tail visualization are deferred; any future observer
  should remain separate from playback.
