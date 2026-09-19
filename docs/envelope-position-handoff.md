# `position()`: what shipped, and what it makes redundant

Handoff for PR #77 (branch `envelope-followups`). Each claim below is a claim to verify
against the code it points at, not a decision already made.

## What shipped

`EnvelopePlayer.position(time?)` and `EnvelopeRuntime.position(time?)` report how far
into its shape a live run has got, or `null` when no run is live.

The number already existed inside the envPlayer's `valueAt` closure, which is what lets a
future-dated release hand off the value the envelope will actually have reached rather
than the param's current one. It had no way out. `positionAt()` is now split out of
`valueAt` so both read from one place.

Nothing calls `position()` yet. Nothing in the module changed what it plays.

### The unit

Seconds of envelope time, measured from `points[0].time`. **Not** wall seconds since the
trigger:

```
position = (time - anchorTime) * timeScale
```

Seconds is forced, not chosen: point times reach the parameter as
`startTime + (points[i].time - points[from].time) / timeScale`, which lands in
`linearRampToValueAtTime`, which reads `AudioContext` seconds.

`anchorTime` is where point 0 _would have_ been, which for a run opened with `fromPoint`
is earlier than the trigger. A loop wraps the result into `[0, cycle)`; a sustained run
clamps it at the sustain point.

### Error behaviour

- Non-finite `time` throws `RangeError`, checked before the live-run test. `null` already
  means "no live run", so overloading it would leave a caller unable to tell a missing run
  from a bad timestamp. An rAF loop calling `position()` with no argument never reaches
  this, since the default is `clock.currentTime`.
- `EnvelopeRuntime.trigger` now validates `options.envelope`, which it previously took on
  trust, before replacing the active player.

## Still missing: a UI test

Everything here is covered by `test/fakeParam.ts`, which records automation calls instead
of producing sound. No test drives a real `AudioContext`, and no test polls `position()`
the way a display would.

Add `src/nodes/params/envelopes/test/position.browser.test.ts`. The browser suite runs on
a real Chrome via `vitest.browser.config.ts` (`vp run test:browser`); see
`src/nodes/params/LFOs/LFO.browser.test.ts` for the closest existing shape.

What it should establish, roughly in order of value:

1. **Position tracks a real clock.** Trigger against a real `AudioParam`, wait, and assert
   `position()` advances in step with `context.currentTime` at `timeScale` 1. The node
   suite only ever sets `currentTime` by hand.
2. **A loop wraps on a real clock.** Run past a cycle boundary and assert the position
   drops back rather than accumulating. The node test fakes the clock, so it never
   exercises the refill timer running alongside.
3. **Position and the parameter agree.** `base + amount * interpolateAtTime(points, p0.time + position())`
   should match `param.value` within a tolerance. This is the claim the whole accessor
   rests on, and nothing checks it today.
4. **rAF polling is stable.** Poll across ~30 frames and assert the position is monotonic
   within a cycle and never `NaN`. This stands in for the display use case.

Point 3 is the one worth writing first. If position and the parameter ever disagree, every
consumer below inherits the error.

## Potentially redundant after this

Nothing here is dead yet: no caller has migrated. These are things `position()` can now
express, listed so they get retired deliberately rather than left to rot.

### `EnvelopePlayer.currentPoint()`

Computes a point index from the same position owned by the player. `EnvelopeRuntime`
only delegates to it. The sampler uses it when enabling a loop on a live run.

Note the semantic difference if you rewrite it: `currentPoint()` returns `null` for a
looping run, while `position()` returns a wrapped value. Deciding a looping run _does_
have a current point is probably the improvement, but it is a behaviour change, not a
refactor.

### `EnvelopePlayer.nextCycleTime()`

Owned by the player and exposed through the compatibility runtime. Mostly derivable:

```
nextCycleTime = now + (cycleLength - position()) / timeScale
```

Callers coordinate this directly or through the temporary sampler adapter
`applyOnNextEnvLoopCycle`.

**Caveat, verified:** a run that has not started yet returns `startTime` today, because it
is already waiting on a seam. `position()` returns 0 for that case (it clamps at
`Math.max(0, …)`), so the derivation gives `now + one full cycle` instead. Reproducing the
current answer needs the anchor, which `position()` does not expose. Either expose the
anchor or keep this method.

### `#activeRun` — removed

Run position, duration, release duration, point index, and cycle boundaries now come from
the envPlayer. `EnvelopeRuntime` no longer keeps a second model of the active run.

### `onPoint` / `onComplete` and their three timer fields

The optional `observeEnvelopePlayer()` decorator now owns these wall-clock notifications
and their timers. `EnvelopeRuntime` has no callback or notification responsibility.

**Not a clean swap, verified:** `position()` returns `null` once released, so the release
tail's `onComplete` is not derivable from polling. Either keep a completion event, or give
the release tail its own position, before removing anything here.

### `fromPoint`

Superseded in principle by a `fromPosition` (continuous rather than quantized), which
would also drop the "looping runs only" restriction, since there is no point grid to land
on. Not urgent; it is the same off-by-one-segment error as `currentPoint()`, from the same
cause.

## Order I would take it in

1. The browser test above, point 3 first.
2. Rewrite `currentPoint()` over `position()`, keeping its `null`-for-loop behaviour so the
   change stays a refactor. Decide the loop semantics separately.
3. Decide the `nextCycleTime` caveat: expose the anchor, or leave the method alone.
4. Keep callback observation optional and separate from playback.

`docs/envelope-followups.md` still holds the larger open questions (merging `sustain` and
`release`, a loop `until` index, splitting `EnvelopeRuntime` into a store and a run
handle). None of them block the above.
