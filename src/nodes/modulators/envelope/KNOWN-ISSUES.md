# Envelope follow-ups

Backlog for this main-thread `Envelope` module. The sampler no longer uses it:
`SampleVoice` sends its envelopes to the sample-player processor
(`src/worklets/processors/play/engine/voice-envelopes.js`), which restarts loop-synced
envelopes on its own loop wraps. Sampler-specific follow-ups (live-edit rules, exact
release length) live with that code.

## Live edits

- **Pending handover.** `Envelope.trigger` replaces its run fields immediately, even
  for a future loop boundary. Reads and a note-off before that boundary can therefore
  use the incoming run rather than the one still sounding. Repeated drag edits should
  continue targeting the same pending boundary. A boundary alone does not guarantee
  continuity if the new shape's opening value differs.

## Scheduling and lifecycle

- **Future commands.** Releasing or stopping a loop removes its refill callback
  immediately, even if the requested time is beyond the queued horizon. `stop(time)`
  pins the value the scheduled timeline has at that time.

## Observation and callers

- `position()` wraps loops and clamps sustain, but one-shots advance beyond their end.
  It becomes null as soon as release is requested, including future release, and does
  not describe the release tail. It is not a completion signal. No envelope-specific
  browser test currently verifies position against rendered automation. When adding
  one (model on `../LFO/LFO.browser.test.ts`, run with `vp run test:browser`), compare
  the value at the reported phase against rendered automation on a real
  `AudioContext`, accounting for mapped endpoints, exponential floors and signed
  linear fallbacks. Raw shape interpolation followed by base/depth mapping is not
  a reliable oracle for those curves; the existing tracker/render comparison is
  useful precedent. Then check that position tracks the real clock and wraps at loop ends.
- Keep `nextCycleTime()` until a replacement handles future starts and pickup anchors;
  position alone does not provide those. `currentPoint()` currently returns null for loops.
- Post-FX/instrument-bus envelopes remain deferred. Establish the voice pattern first;
  the removed commented-out forwarding code was never active integration.
- Point-edit helpers preserve points-array identity on rejected edits, but rebuilding
  `{ ...shape, points }` creates a new shape identity. Revisit only if an editor needs it.
- Observer callbacks and release-tail visualization are deferred; any future observer
  should remain separate from playback.

## Established behavior and constraints to preserve

These describe current guarantees or accepted limits, not requests to change sound.

- **Sustain glide.** `Envelope.setSustainValue` only responds after sustain is reached.
  It changes the run's point immediately. Sustain-index and mid-attack
  changes remain next-trigger edits. A release or edit during the glide holds the
  glide's current value. Preserve the trigger snapshot for the release tail.
  Rescheduling the rest of the attack from the current position was tried for
  mid-attack edits and still stepped audibly.

- **Validation.** Shape, time scale, base, depth, finite scheduling timestamps, integer loop
  pickup indices, and sustain values/glides are checked before run mutation. Finite past
  times and out-of-range integer pickup indices retain their existing clamping.

- **Accepted rounding guard.** Keep `Math.max(grid, cycleEnd)` in `Envelope.trigger`:
  it prevents an opening event preceding the previous closing ramp. Its measured
  accumulated error is tiny; do not remove it as an incidental simplification.
