# Proposal: what an envelope edit may change, and when

Status: partly applied. Scope is `src/nodes/params/envelopes/` only.

| Part                                | State                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| B - late-bound release stage        | Not applied. `release(startTime)` still reads the trigger snapshot.         |
| D - resuming from the sustain point | Applied (`5c58ad1`), with a different API than the one proposed below.      |
| The deferred sustain question       | Half answered (`d8bf8cd`): the sustain **value** is live, the index is not. |

## Context to read first

Everything needed is in four places. No search required.

| File                                                                 | What to look at                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/nodes/params/envelopes/EnvelopeRuntime.ts`                      | `#activeRun`, `trigger()`, `release()`, and callback scheduling                                                   |
| `src/nodes/params/envelopes/Envelope.ts`                             | `createEnvelopePlayer()` (closure state, `valueAt`, the `addLoop` refill), `scheduleRange()`, `releaseEnvelope()` |
| `src/nodes/params/envelopes/EnvelopeRuntime.test.ts`                 | the `live settings handover` and `repeated handovers` describes                                                   |
| `src/nodes/instruments/Sample/temporary-sample-envelope-adapters.ts` | `resolveSampleEnvelopeTrigger()` — why the compatibility runtime keeps a second, mapped snapshot                  |

Shipped already (commit `701bc35`): an edit to a running envelope hands over on the
next loop boundary, where point 0 comes round anyway, so the swap is continuous by
construction. `nextCycleTime()` reports that boundary; null means no boundary, wait for
the next trigger.

## The rule this proposal is trying to state once

> A run's inputs are fixed once they are on the timeline. A run may only be replaced at
> a point where the parameter already holds the new shape's value at a known point index.

Two consequences, which are the two parts below.

## Part B — the release stage binds at note-off, not at trigger

### Problem

`release()` schedules the tail from `#activeRun`, the snapshot taken at trigger. So:

- Editing the release index mid-note does nothing until the next trigger, even though
  the tail is not on the timeline yet and nothing about changing it is audible.
- For the sampler's filter envelope, `resolveSampleEnvelopeTrigger()` maps normalized
  point values to Hz against the cutoff **as it was at note-on**. Move the cutoff knob
  during a held note and the release tail sweeps to the wrong frequencies. Live bug,
  independent of live editing.

### Change

`release()` takes the same late-bound options `trigger()` does:

```ts
release(startTime: number, options: EnvelopeRuntimeTriggerOptions = {}): void
```

Omitted fields fall back to the run's, so every existing call site keeps working.

Threading required:

- `EnvelopePlayer.release(time, options?)` — currently closes over the trigger's
  `envelope`, `base`, `amount`, `timeScale`.
- `releaseEnvelope()` already takes the envelope and options as parameters. No change.
- `holdValue` must still come from the **outgoing** shape via `valueAt()`. That is what
  makes the swap continuous: pin where the old shape actually got to, then ramp to the
  new tail. Do not let the override reach `valueAt`.
- `EnvelopeRuntime.releaseDuration()` and `#startReleasePointCallbacks()` read
  `#activeRun.envelope` and need the override too.

### Why not simply drop the snapshot and always read `#settings`

`#activeRun.envelope` is the _mapped_ shape for filter-env (normalized → Hz), which is
not `#settings.envelope`. Reading settings at release time would compute the handoff
from a shape that was never playing. The snapshot has to stay; only the tail is late.

### Check

One test: trigger a sustaining envelope, `applySettings` with a different release index,
release, assert the tail follows the new points and starts from the held value.
`fakeParam.ts` records the automation.

## Part D — a seam can say where to resume, not just when

### Problem

`nextCycleTime()` gates on `#activeRun.envelope.loop`, the **outgoing** run's flag. So:

- Disabling loop on a looping run works. The old run is looping, a boundary exists, the
  handover installs the sustaining shape. Already correct.
- Enabling loop on a sustaining run does nothing. The old run is not looping, so the
  answer is null and the edit waits for the next trigger.

A run parked at its sustain point is sitting on `points[sustain].value`. That is a known
point index, exactly like a loop boundary sits on index 0. It is a seam; the API just
cannot express it, because it returns a time and assumes index 0.

Resuming there also rebinds `timeScale`, so enabling loop picks up a pending playback-rate
sync at the same moment rather than at the next note.

### Change — applied in a different shape; see Naming below

The seam accessor returns where as well as when:

```ts
{ startTime: number; fromIndex: number } | null
```

- looping run → `{ next boundary, 0 }`
- run parked at sustain → `{ now, sustain }`
- neither → `null`

`trigger()` gains a `fromIndex` option. Player work:

- `scheduleRange()` already takes a `from` index. The trigger path hardcodes 0.
- The loop refill anchors cycle _n_ at `time + n * duration`. With a pickup the anchor
  becomes `time + pickupDuration`, where `pickupDuration` covers `fromIndex → end`, and
  the first full cycle starts there.
- `valueAt()` assumes phase starts at `points[0].time`. With a pickup it starts at
  `points[fromIndex].time`. This is the fiddly part and the one most worth an ear test —
  get it wrong and the release handoff pins the wrong value.

### Naming — superseded by what shipped

The naming problem below was sidestepped rather than solved. `nextCycleTime(): number |
null` kept its name and its job of reporting a loop boundary, and the sustain pickup
became two separate pieces: `EnvelopeRuntime.currentPoint()` reports the point a
non-looping run has reached, and `trigger()` takes a `fromPoint` to open there. One
accessor returning `{ startTime, fromIndex }` was not needed, because the caller already
knows which of the two cases it is in.

Kept for the reasoning:

> `nextSeam` was rejected as too vague, and it is. `nextLoopCycle` has the opposite
> problem: the sustain pickup is not a loop cycle, so the name would lie in exactly the
> case D exists to add.
>
> Suggested: **`nextRestartPoint()`** — it names what the caller does with it.

### Constraint to document

The sustain seam is exact only while the edit leaves `points[sustain].value` alone. A
pure loop toggle does. Moving that point is handled separately, below.

## The sustain value, applied separately (`d8bf8cd`)

The deferred sustain question turned out to be two questions with different answers.

**The value is live.** A sustained run schedules points `0..sustain` and stops, so the
hold is an absence of scheduled events rather than an event. Nothing is queued after it
to reschedule and no seam has to be waited for: pin, glide, done.
`EnvelopePlayer.setSustainValue()` does that and `applySettings` forwards to it.

The point is mutated in place on the run's own clone, because `valueAt` and
`releaseEnvelope` read that same object. Without the mutation the note-off handoff pins
the old value and jumps, which is the whole bug the seam rule exists to prevent.

**Only while the run is already parked there.** Earlier than the sustain point the
points between now and sustain are still on the timeline, and the cancel needed to write
the new value takes them with it: the parameter abandons the attack peak and heads
straight for the sustain value. Rescheduling the remainder from the current position was
tried and still steps audibly, so mid-flight edits wait for the next trigger like
everything else. That one is still open.

**The index is unchanged.** Still deferred, for the reason in the original ticket: the
held value would have to jump or glide, and there is no seam that avoids it.

## Staging

D and the sustain value landed first, each in its own commit, and neither needed the
rename. What is left is B on its own:

1. ~~**D** — the sustain pickup and the player's pickup-then-loop path.~~ `5c58ad1`.
2. ~~The sustain **value** on a held note.~~ `d8bf8cd`.
3. **B** — the late-bound release stage. Mechanical, and it is the one that fixes the
   live cutoff bug in Part B's second bullet.

`EnvelopeRuntime` is exported from `src/index.ts` and none of this has been released yet,
so B may still change the `release()` signature without a deprecation.

## Explicitly out of scope

- Changing the sustain index mid-note. No seam exists; the held value would have to jump
  or glide. Deferred by decision. The sustain _value_ is live while the note is parked on
  it; see above.
- Phase continuation for non-looping envelopes generally.
- Anything in `temporary-sample-envelope-adapters.ts`. Sampler policy stays deferred there.
