# Envelope timeline tracking

Pending core work, as of `70733a7`. Entry point: [HANDOFF.md](HANDOFF.md). Copy the blocks in yourself.

1. **Root fix:** `Envelope` pins release/sustain/stop holds at a value it works out from the shape, which doesn't match what the param is actually playing. That's the source of the release-during-attack click. Fix: record what was scheduled and read it back (`TrackedParam`).
2. **Optional:** amp `amount` as depth around the gate instead of a level multiplier.

## Done: disabled amp env plays as a gate (`20776fe`)

A disabled amp envelope used to leave `envGain` at its default `0` (silent), or frozen mid-level if it was switched off during a note. Now `#resetEnvTarget` holds it at velocity / 127, `release()` fades it out with a 2 ms time constant, and `releaseTime` returns the 10 ms gate fade. Changeset: `.changeset/amp-env-gate.md`. Moving the gate fade into the processor is #65.

---

## 1. Read holds from the scheduled timeline

Fixes the click when a voice is released during an exponential attack that starts at 0. Independent of section 2. Verified in a scratch worktree on `5f391f5`: `vp test` passed, `vp check` was clean, and both tests below fail on the old code. Every block still matches the code as of `70733a7`, which removed `toParamValue` and `scaling`; not re-run since.

### Root cause

Two places answer "what is the param's value at time t", and they disagree:

- **The scheduler** writes the real timeline, changing values on the way: a zero endpoint is floored to `1e-4·amount` (`floorOffZero`), `rampCurve` swaps exponential segments for linear ones, and the `curve` override applies.
- **`Envelope.#valueAt`** rebuilds the value from the shape with `interpolateAtTime`, which knows about none of that. For an exponential segment leaving 0, it falls back to **linear** (`left.value > 0` fails).

Release, sustain edits and stop then use `cancelAndPinParamValue` to pin `#valueAt`'s answer onto a param that is following the other one. Example: a 0→1 exponential attack over 10 ms, released at 5 ms. The param is at `1e-4^0.5 = 0.01`, `#valueAt` says `0.5`, and the gain steps by ~0.49 in one sample.

### Fix

Don't re-derive the value. Record what was scheduled and evaluate that, using the Web Audio spec formulas. This is how Tone.js `Param` works: it records every automation call in `this._events` ("The timeline which tracks all of the automations"), computes `getValueAtTime` from that list, and builds its own `cancelAndHoldAtTime` from it. It also applies its zero floor (`_minOutput = 1e-7`) inside `exponentialRampToValueAtTime` _before_ recording, so its mirror and the real param can't disagree. That's the property this change copies.

`TrackedParam` sits behind the existing `AutomatableParam` seam, so the scheduling code is unchanged. `Envelope` wraps whatever param it's given, and every write (trigger, loop refills, release, sustain glide) goes through the wrapper.

Side effects, all improvements:

- A release during the sustain-edit glide now hands off from where the glide has actually got to. That's the `ponytail:` caveat in `setSustainValue`, now resolved.
- `stop(time)` pins the value at `time`, not today's `param.value`.

### 1a. New file — `src/nodes/params/envelopes/tracked-param.ts`

```ts
import type { AutomatableParam } from './envelope-scheduling';

type ParamEvent = { type: 'set' | 'linear' | 'exponential'; value: number; time: number };

/**
 * Forwards automation to a param and keeps a copy of what was scheduled, so `valueAt`
 * reads the timeline the param actually plays rather than re-deriving it from a shape.
 * Floors, curve overrides and anything else applied on the way in are in the copy too.
 *
 * Values follow the Web Audio spec's automation formulas:
 * https://www.w3.org/TR/webaudio/#computation-of-value
 * Same approach as Tone.js `Param`, which mirrors every event in a `Timeline`:
 * https://github.com/Tonejs/Tone.js/blob/main/Tone/core/context/Param.ts
 *
 * ponytail: only sees writes made through this wrapper, and no `setTargetAtTime`.
 * Route other writers through it, and add the setTarget formula, if they need reading.
 */
export class TrackedParam implements AutomatableParam {
  #events: ParamEvent[] = [];

  constructor(
    readonly param: AutomatableParam,
    readonly clock: { readonly currentTime: number },
  ) {}

  get value() {
    return this.param.value;
  }

  set value(value: number) {
    this.param.value = value;
  }

  setValueAtTime(value: number, time: number) {
    this.#add({ type: 'set', value, time });
    this.param.setValueAtTime(value, time);
    return this;
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.#add({ type: 'linear', value, time });
    this.param.linearRampToValueAtTime(value, time);
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.#add({ type: 'exponential', value, time });
    this.param.exponentialRampToValueAtTime(value, time);
    return this;
  }

  cancelScheduledValues(time: number) {
    this.#events = this.#events.filter((event) => event.time < time);
    this.param.cancelScheduledValues(time);
    return this;
  }

  /** The value the param has at `time`, from the automation scheduled through this wrapper. */
  valueAt(time: number): number {
    const events = this.#events;
    const nextIndex = events.findIndex((event) => event.time > time);
    const prevIndex = (nextIndex === -1 ? events.length : nextIndex) - 1;
    // Nothing scheduled at or before `time`: only the live value is known.
    if (prevIndex < 0) return this.param.value;

    const { value: v0, time: t0 } = events[prevIndex];
    const next = events[nextIndex];
    if (!next || next.type === 'set') return v0;

    const progress = (time - t0) / (next.time - t0);
    if (next.type === 'linear') return v0 + (next.value - v0) * progress;
    // The spec holds an exponential ramp at its start when an end is zero or the signs differ.
    if (v0 * next.value <= 0) return v0;
    return v0 * (next.value / v0) ** progress;
  }

  #add(event: ParamEvent) {
    // After any event at the same time: the spec applies same-time events in call order.
    const index = this.#events.findIndex((other) => other.time > event.time);
    if (index === -1) this.#events.push(event);
    else this.#events.splice(index, 0, event);

    // Drop events the param has already played past; the latest one still starts the next ramp.
    const now = this.clock.currentTime;
    while (this.#events.length > 1 && this.#events[1].time <= now) this.#events.shift();
  }
}
```

The pruning in `#add` keeps the list short for long loops. It's only correct for `valueAt(t >= now)`, and every caller already clamps to now.

### 1b. `src/nodes/params/envelopes/Envelope.ts`

**Imports.** Replace:

```ts
import {
  assertValidEnvelopeShape,
  getDuration,
  interpolateAtTime,
  type EnvelopeShape,
  type EnvelopeCurve,
} from './envelope-shape';
```

With:

```ts
import {
  assertValidEnvelopeShape,
  getDuration,
  type EnvelopeShape,
  type EnvelopeCurve,
} from './envelope-shape';
import { TrackedParam } from './tracked-param';
```

**Constructor.** Replace:

```ts
  #triggerTime = 0;
  #startTime = 0;

  constructor(
    readonly clock: EnvelopeClock,
    readonly param: AutomatableParam,
    shape: EnvelopeShape,
  ) {
    this.#shape = snapshot(shape);
  }
```

With:

```ts
  #triggerTime = 0;
  #startTime = 0;
  /** Every write goes through this, so holds read back what was actually scheduled. */
  readonly param: TrackedParam;

  constructor(
    readonly clock: EnvelopeClock,
    param: AutomatableParam,
    shape: EnvelopeShape,
  ) {
    this.param = new TrackedParam(param, clock);
    this.#shape = snapshot(shape);
  }
```

**Delete `#valueAt`** completely:

```ts
  /** The envelope's value at `time`, wherever the shape has got to by then. */
  #valueAt(time: number) {
    if (!this.#envShape) return this.#base;
    const { points } = this.#envShape;
    if (points.length === 0) return this.#base;

    return (
      this.#base + this.#amount * interpolateAtTime(points, points[0].time + this.#positionAt(time))
    );
  }
```

**`trigger`, loop anchor comment.** Replace:

```ts
// every cycle boundary below still lands on the same grid and `valueAt` keeps
// reading the right phase.
```

With:

```ts
// every cycle boundary below still lands on the same grid and `position` keeps
// reading the right phase.
```

**`release`.** Replace:

```ts
// Read the shape before anything touches the param, so a future-dated release hands
// off the value the envelope will actually have reached rather than today's.
const holdValue = this.#valueAt(time);
```

With:

```ts
// Read the scheduled timeline before anything touches the param, so a future-dated
// release hands off the value the param will actually have reached rather than today's.
const holdValue = this.param.valueAt(time);
```

**`setSustainValue`.** Three edits. First, replace:

```ts
// The point is mutated in place because `valueAt` and `releaseEnvelope` read the same
// object; without that the note-off handoff would pin the old value and jump.
```

With:

```ts
// The point is mutated in place because `releaseEnvelope` and later edits read the same
// object; without that they would schedule from the old value and jump.
```

Second, delete the resolved caveat:

```ts
//
// ponytail: releasing mid-glide pins the shape's value, which is the glide's target
// rather than where it has actually got to, so a note-off inside the glide window can
// step by up to the edit distance. Inaudible while `glide` stays short. Track the
// pending glide in `valueAt` if a long one is ever wanted.
```

Third, replace:

```ts
// Read the outgoing shape before mutating it, the same ordering release() follows.
const holdValue = this.#valueAt(time);
```

With:

```ts
// Read the timeline before cancelling it, the same ordering release() follows.
const holdValue = this.param.valueAt(time);
```

**`stop`.** Replace:

```ts
cancelAndPinParamValue(this.param, time);
```

With:

```ts
cancelAndPinParamValue(this.param, time, this.param.valueAt(time));
```

### 1c. Tests — `src/nodes/params/envelopes/test/Envelope.test.ts`

The existing test `'glides a held sustain to a new value and releases from it'` asserted the old approximation: release at the glide's start pins the glide's target. Replace:

```ts
// The tail has to hand off from the edited value, not the one captured at trigger.
// The glide's own pin sits at this same instant, so it is the last write that counts.
player.release(1);
const pins = param.ramps().filter((event) => event.type === 'set' && event.time === 1);
expect(pins.at(-1)?.value).toBe(0.25);
```

With:

```ts
// The tail hands off from where the glide has got to: halfway from 1 to 0.25.
clock.currentTime = 1.01;
player.release(1.01);
const pins = param.ramps().filter((event) => event.type === 'set' && event.time === 1.01);
expect(pins.at(-1)?.value).toBeCloseTo(0.625, 9);
```

Append the regression test for the click. On the old code it gets `0.5`:

```ts
// An exponential attack from 0 ramps from the floor, near silent until late in the segment.
// Release has to pin that value, not a linear reading of the shape, or the gain steps.
test('release during an exponential attack from zero pins the scheduled value', () => {
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const env = new Envelope(clock, param, {
    mode: { type: 'sustain' },
    sustainPoint: 1,
    points: [
      { time: 0, value: 0, curve: 'exponential' },
      { time: 0.01, value: 1, curve: 'exponential' },
      { time: 0.1, value: 0, curve: 'exponential' },
    ],
    releasePoint: 1,
  });

  env.trigger(0);
  clock.currentTime = 0.005;
  env.release(0.005);

  const pin = param.ramps().find((event) => event.type === 'set' && event.time === 0.005);
  // Halfway along a 1e-4 -> 1 exponential ramp: sqrt(1e-4), not the linear 0.5.
  expect(pin?.value).toBeCloseTo(0.01, 6);
});
```

### 1d. `src/nodes/params/envelopes/KNOWN-ISSUES.md`

Replace the resolved item:

```md
- **Release-value agreement.** Release, sustain edits and stop pin `#valueAt`, which
  re-derives the value from the shape (`interpolateAtTime`). The param plays what the
  scheduler wrote: zero endpoints floored by `floorOffZero`, exponential ramps on param
  values rather than shape values. They disagree for an exponential segment leaving 0 or a
  nonzero `base`: releasing halfway through a 0 to 1 exponential attack pins 0.5 while the
  param is near 0.01, a click. Planned fix: wrap the param in a `TrackedParam` that records
  scheduled events and evaluates them with the spec's automation formulas, as Tone.js
  `Param` does, and read every hold from it. Zero crossings already agree (`rampCurve`).
  Also check that cancelling a future ramp preserves the trajectory before note-off.
```

With what's left of it:

```md
- **Future-ramp truncation.** Holds read the scheduled timeline (`TrackedParam.valueAt`),
  but the pin still cancels a ramp ending after the hold time, so between now and a
  future-dated hold the param stops at the previous event's value instead of ramping on.
  Fix in `TrackedParam`: replace the cancelled ramp with one of the same type ending at
  the held value.
```

And in **Future commands**, replace:

```md
also pins today's parameter value rather than a value evaluated at that future time.
```

With:

```md
pins the value the scheduled timeline has at that time.
```

### Follow-up, not included: how the attack sounds

The click is fixed by 1, but an exponential ramp that starts at the floor still sits near silent for most of the attack and then jumps up, so the attack sounds late. Tone's `Envelope.triggerAttack` doesn't use `exponentialRampTo` for an `"exponential"` attack. It calls `targetRampTo`, which is `setTargetAtTime` (an RC charge curve, like an analog ADSR) with time constant `Math.log(rampTime + 1) / Math.log(200)`, then a linear ramp from 90% onwards so it lands exactly on the target. Release does the same with `targetRampTo(0, release, time)`. Copying that here means teaching `schedulePoint` a setTarget path for rising exponential segments and adding the setTarget formula (`v1 + (v0 - v1) * exp(-(t - t0) / τ)`) to `TrackedParam.valueAt`. That's a change to the sound, so it gets its own decision.

---

## 2. Amp amount as depth (undecided) — `src/nodes/instruments/Sample/sample-envelope-policy.ts`

In `resolveSampleEnvelopeTrigger`, replace:

```ts
if (id === 'amp') return { amount: velocityGain(velocity) * amount };
```

With:

```ts
// Depth around a gate: 0 holds at velocity, 1 is the full envelope.
if (id === 'amp') {
  const gain = velocityGain(velocity);
  return { base: gain * (1 - amount), amount: gain * amount };
}
```

and add `'base'` to its return type's `Pick`.

`envGain = v·(1 − amount) + v·amount·value`, which is `v` at amount 0 and `v·value` at amount 1.

**Trade-off.** With `0 < amount < 1`, the release ends at `v·(1 − amount)`, not 0. The voice then hard-stops at `releaseTime`, so the click gets bigger as amount gets smaller. Fixing that properly needs the processor-side fade from issue #65. If that's not acceptable yet, skip this: amount stays a level multiplier, and amount 0 stays silent by design.

`amount < 0` gives `base > v`, which the worklet param's `maxValue: 1` clamps. Clamp `amount` to `[0, 1]` for amp if inverted amp envelopes aren't wanted.

### Test — `sample-envelope-policy.test.ts`

In `'scales amplitude by velocity and pitch and filter detune in cents, without changing the shape'`, replace:

```ts
expect(amp.amount).toBeCloseTo(0.8 * amount);
```

With:

```ts
expect(amp.base).toBeCloseTo(0.8 * (1 - amount));
expect(amp.amount).toBeCloseTo(0.8 * amount);
```

---

## Known gaps

- `TrackedParam` only sees writes made through `Envelope`. The amp gate and `#resetEnvTarget` write `envGain`/detune directly. That's fine today because every trigger cancels everything first, but anything that wants to read those values back has to go through the wrapper.
- No `SampleVoice` test for the gate (disabled amp: `envGain` reaches velocity, then 0 after release).
- If the amp env is enabled mid-note, the gate holds until the next note. It doesn't pick up the envelope partway through.

## Sources

- Tone.js `Param` (event timeline, `getValueAtTime`, `cancelAndHoldAtTime`, `_minOutput` floor, `setRampPoint`, `exponentialApproachValueAtTime`): https://github.com/Tonejs/Tone.js/blob/main/Tone/core/context/Param.ts
- Tone.js `Envelope` (`triggerAttack`/`triggerRelease`, `targetRampTo` for exponential curves): https://github.com/Tonejs/Tone.js/blob/main/Tone/component/envelope/Envelope.ts
- Web Audio API, AudioParam automation value computation (linear, exponential, setTarget formulas; exponential hold on zero or opposite signs): https://www.w3.org/TR/webaudio/#computation-of-value
- Firefox `cancelAndHoldAtTime` status: https://bugzil.la/1308431
