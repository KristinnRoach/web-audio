# Envelope follow-ups

Single backlog for envelope internals and sampler integration. Current live editing,
including switching to and from loop mode, is intentionally preserved: it works well
in the consuming app's listening sessions. These are follow-ups, not a cleanup-PR checklist.
Code observations below are not claims that every case has been reproduced audibly.

## Live edits

- **Point-quantized loop pickup.** `applySampleEnvelopeShapeEdit` in
  `../../instruments/Sample/sample-envelope-policy.ts` resumes from `currentPoint()`.
  Mid-segment, this can jump back to the preceding point. Preserve the held-sustain
  pickup when revisiting continuous continuation; `fromPoint` currently only supports loops.
- **Pending handover.** `Envelope.trigger` replaces its run fields immediately, even
  for a future loop boundary. Reads and a note-off before that boundary can therefore
  use the incoming run rather than the one still sounding. Repeated drag edits should
  continue targeting the same pending boundary. A boundary alone does not guarantee
  continuity if the new shape's opening value differs.
- **Sustain glide.** `Envelope.setSustainValue` only responds after sustain is reached.
  It changes the run's point immediately; release or another edit during the glide
  reads the target rather than the intermediate value. Sustain-index and mid-attack
  changes remain next-trigger edits. Preserve the trigger snapshot for the release tail.
- **Filter sustain mapping.** `getLiveSampleEnvelopeSustainValue` deliberately skips
  filter envelopes. A future implementation needs the active note's normalized-to-Hz
  mapping; recomputing it from current filter settings may use a different range.

## Scheduling and lifecycle

- **Release-tail cleanup.** `Envelope.release` clears `#triggered`, so a subsequent
  `stop()` does not cancel the tail. Revisit alongside sampler disable, reuse and disposal.
- **Release-value agreement.** `Envelope.#valueAt` interpolates the original shape,
  while `envelope-scheduling.ts` maps and floors exponential endpoints. Zero endpoints,
  negative values and nonzero base offsets need consistent evaluation and scheduling.
  Also check that cancelling a future ramp preserves the trajectory before note-off.
- **Future commands.** Releasing or stopping a loop removes its refill callback
  immediately, even if the requested time is beyond the queued horizon. `stop(time)`
  also pins today's parameter value rather than a value evaluated at that future time.
- **Validation.** Shape and time scale are validated before trigger mutation, but
  timestamps, base, amount, pickup indices and sustain-glide inputs are not consistently
  checked. Invalid inputs should eventually leave the existing run untouched.
- **Reported loop drift.** The cause remains unconfirmed. The existing 3,001-cycle
  grid check measured roughly 1e-12 seconds of error for a 7 ms loop. Investigate
  refill starvation (1 s lookahead, 50 ms timer) and sampler playback-rate/time-scale
  composition before changing the grid. Listen in the consuming app after changes.
- **Accepted rounding guard.** Keep `Math.max(grid, cycleEnd)` in `Envelope.trigger`:
  it prevents an opening event preceding the previous closing ramp. Its measured
  accumulated error is tiny; do not remove it as an incidental simplification.

## Observation and callers

- `position()` wraps loops and clamps sustain, but one-shots advance beyond their end.
  It becomes null as soon as release is requested, including future release, and does
  not describe the release tail. It is not a completion signal. No envelope-specific
  browser test currently verifies position against rendered automation.
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

## Release bookkeeping

The pending minor changeset documents migration from published 0.4.2, alongside the
filter changeset. Intermediate APIs such as `EnvelopeRuntime` were never in that
release. Keep consumer migration notes based on the published API when revisiting it.
