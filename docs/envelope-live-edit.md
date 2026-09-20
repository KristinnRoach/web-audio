# Proposal: what an envelope edit may change, and when

Status: partly applied. Scope is `src/nodes/params/envelopes/` only.

| Part                                | State                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| B - late-bound release stage        | Rejected. `release(startTime)` reads the active run's trigger snapshot.     |
| D - resuming from the sustain point | Applied (`5c58ad1`), with a different API than the one proposed below.      |
| The deferred sustain question       | Half answered (`d8bf8cd`): the sustain **value** is live, the index is not. |

## Context to read first

Everything needed is in four places. No search required.

| File                                                                 | What to look at                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/nodes/params/envelopes/EnvelopeRuntime.ts`                      | settings compatibility, `trigger()`, and `release()`                                                              |
| `src/nodes/params/envelopes/Envelope.ts`                             | `createEnvelopePlayer()` (closure state, `valueAt`, the `addLoop` refill), `scheduleRange()`, `releaseEnvelope()` |
| `src/nodes/params/envelopes/EnvelopeRuntime.test.ts`                 | the `live settings handover` and `repeated handovers` describes                                                   |
| `src/nodes/instruments/Sample/temporary-sample-envelope-adapters.ts` | `resolveSampleEnvelopeTrigger()` — creates a mapped envelope for one player                                       |

Shipped already (commit `701bc35`): an edit to a running envelope hands over on the
next loop boundary, where point 0 comes round anyway, so the swap is continuous by
design. `nextCycleTime()` reports that boundary; null means no boundary, wait for the
next trigger.

## The rule this proposal is trying to state once

> A run's inputs are fixed once they are on the timeline. A run may only be replaced at
> a point where the parameter already holds the new shape's value at a known point index.

Two consequences, which are the two parts below.

## Part B — the release stage stays bound to the trigger

Resolved: each trigger owns one snapshot, including its release tail. Definition edits
affect the next trigger only; `setSustainValue()` remains the explicit live exception.
This keeps the release handoff on the same mapped shape and timing that produced the
active run.

## Part D — a seam can say where to resume, not just when

### Problem

`nextCycleTime()` gates on the envPlayer's **outgoing** envelope. So:

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
rename. B was then closed by the trigger-snapshot lifecycle decision:

1. ~~**D** — the sustain pickup and the player's pickup-then-loop path.~~ `5c58ad1`.
2. ~~The sustain **value** on a held note.~~ `d8bf8cd`.
3. ~~**B** — the late-bound release stage.~~ Rejected in favor of one trigger snapshot
   for the entire run.

## Explicitly out of scope

- Changing the sustain index mid-note. No seam exists; the held value would have to jump
  or glide. Deferred by decision. The sustain _value_ is live while the note is parked on
  it; see above.
- Phase continuation for non-looping envelopes generally.
- Anything in `temporary-sample-envelope-adapters.ts`. Sampler policy stays deferred there.
