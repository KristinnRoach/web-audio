# Envelope follow-ups

Single backlog for envelope internals and sampler integration. Current live editing,
including switching to and from loop mode, is intentionally preserved: it works well
in the consuming app's listening sessions. These are follow-ups, not a cleanup-PR checklist.
Listening tests reported clicks on some sample loop boundaries after the `loopSync`
change. Rendered tests isolated dropped closing ramps and late attack resets; both
are fixed below. Other observations remain candidates, not confirmed audible defects.

## Audio-thread envelopes (open)

Audio-rate accuracy needs envelopes on the audio thread. Undecided: move this module's
playback into a processor, or keep it and add a processor implementation only for
cases such as sampler `loopSync`. That is its own slice; the main-thread follow-ups
below that depend on message timing (handover lead, bridge, per-wrap reports, first-pass
keytracking, pitch tracking) should wait for that decision.

## Real-audio click regression

`../../instruments/Sample/SamplePlayer.loop-clicks.browser.test.ts` captures a real
AudioContext playing a seamless 200 ms tone with full-buffer looping for 3 seconds.
With drift off, a default looped amp shape and `loopSync` on reproduced intermittent
single-sample impulses (one jumped about 0.199 full scale against a peak of 0.5).
Flat synced and unsynced-shape controls stayed below the detector threshold.

Two independent OfflineAudioContext tests isolated the timing defects:

- Future retriggers removed the old closing ramp, holding its preceding value until
  the boundary. Retriggers now preserve the ramp through the handover with `holdAt`.
- Late notifications restarted the next attack at zero instead of its elapsed phase.
  Sampler cycle notifications now opt into `catchUp`, resuming the appropriate segment
  and keeping subsequent cycles anchored to the reported wrap time. These handovers
  are scheduled at least 10 ms ahead; rewriting the current render quantum still
  produced intermittent spikes without that lead. Ordinary note triggers retain
  their restart-at-now behavior.

The real-time regression includes an extra 30 ms notification delay. Fixed-rate,
fixed-range loops stay on phase without needing a future notification protocol.
Run after `vp run build:worklets` with:

```
vp test run --config vitest.browser.config.ts src/nodes/instruments/Sample/SamplePlayer.loop-clicks.browser.test.ts
```

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

## Loop timing

- **Live loop-point clicks.** Fixed: moving loop points while holding a synced note
  changed the reported phase or cycle length, so the catch-up handover stepped. A
  handover whose incoming value differs from the held one by more than 0.1% of depth
  now ramps over 5 ms to the new phase at the ramp's end; matching handovers are set
  directly. Covered by the six-edit case in `SamplePlayer.loop-clicks.browser.test.ts`
  and confirmed by ear there. Not yet covered: a rendered same-duration reanchoring
  assertion, and release/stop during a bridge.

`loopSync` now fits the full loaded buffer's duration to one audible sample loop
for loop-mode envelopes, including the note's playback rate regardless of
`playbackRateSync`. Other timing uses seconds with optional `playbackRateSync`;
there is no hidden loop-snapping correction.

- **Changing pitch while held.** Sync uses the stored note playback rate, not continuous
  glide or pitch-envelope modulation. Continuous phase lock remains unresolved.
- **Boundary restart.** Synced envelopes restart at each sample loop boundary;
  shapes that do not divide evenly into that interval are cut there. The cut is a
  5 ms bridge at the handover, at least 10 ms after the boundary, not a step.
- **Per-wrap message load.** The processor posts `loop:cycle` on every wrap, even
  without an enabled loop-synced envelope. At rate 1, a 5 ms loop produces about
  200 messages/s per voice; enabled loop-synced envelopes retrigger for each message.
  `SampleVoicePool` forwards these too, but `SamplePlayer` already excludes them.
  The consuming app currently listens to `loop:range`, not `loop:cycle`; direct pool
  consumers may still observe cycles. Consider an explicit processor reporting flag
  maintained across envelope enable/mode/sync edits and voice lifecycle, and a separate
  opt-in for upstream cycle observation. Do not simply throttle messages while every
  sample boundary still controls retriggering; that would change envelope playback.
- **Delayed changes to loop timing.** Phase catch-up handles late reports for an
  unchanged loop, but cannot change already rendered audio when rate, range or drift
  changes. A future-boundary protocol would need enough lead time and a policy for
  changing inputs; posting only the next boundary can still be late for tiny loops.
  Message coalescing must retain the newest authoritative phase rather than resetting
  at receipt time.
- **Approximate first-pass keytracking.** `SampleVoice.trigger` scales the already
  processed idle length by `1 + k * (|targetRate| - 1)`. The processor applies that
  scale to the pre-snap length with integer floor/minimum, then snaps boundaries and
  applies drift; these operations do not commute. Idle reports already include base
  quantization and minimum lengths, but cannot predict every post-scale result;
  idle tempo sync also resolves at 120. Voice starts reset processor glide to target,
  so target-versus-glide mismatch is not established for a fresh start here.
  Live reports update the length after the first wrap, but keep using the stored note
  rate (see changing pitch above). A shared multiplier alone will not make the first
  pass exact. Prefer authoritative processor timing with enough lead time; test
  non-integer rates, snapping, glide and tempo sync before changing this path.

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
  - _Time-scale composition._ Loop sync includes the stored note playback rate.
    If the actual sample rate or loop length differs from those inputs, the sample
    and envelope can walk apart. See delayed changes to loop timing and approximate
    first-pass keytracking above. Probe: compare envelope boundaries to sample wraps
    at a non-integer rate with realistic message delay.

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
