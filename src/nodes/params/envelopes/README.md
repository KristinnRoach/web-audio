# envelopes

Breakpoint envelopes for Web Audio. Draw a shape out of points, bind it to an `AudioParam`,
then trigger and release it. See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for all deferred work.

`Envelope` owns parameter scheduling and per-trigger snapshots. `SamplePlayer` owns
editable configs; `SampleVoice` applies them using
[`sample-envelope-policy.ts`](../../instruments/Sample/sample-envelope-policy.ts) for
defaults, parameter mapping and live-edit decisions.

```ts
import { Envelope } from '@kidlib/web-audio';

const ctx = new AudioContext();
const gain = ctx.createGain();

const env = new Envelope(ctx, gain.gain, {
  points: [
    { time: 0, value: 0 },
    { time: 0.01, value: 1 }, // attack
    { time: 0.2, value: 0.6 }, // decay to sustain
    { time: 0.5, value: 0 }, // release
  ],
  mode: { type: 'sustain' },
  sustainPoint: 2,
  releasePoint: 2,
});

env.trigger(); // note on
env.release(); // note off
```

## Shape

```ts
type EnvelopeShape = {
  readonly points: readonly EnvelopePoint[];
  readonly mode: EnvelopeMode;
  readonly sustainPoint: number; // point index
  readonly releasePoint: number; // point index
};

type EnvelopePoint = {
  readonly time: number; // seconds
  readonly value: number;
  readonly curve?: 'linear' | 'exponential' | 'step'; // curve to the next point, default 'linear'
};

type EnvelopeMode =
  | { type: 'once' } // play through to the end
  | { type: 'sustain' } // stop at `sustainPoint` and hold until release
  | { type: 'loop' }; // repeat the whole shape until release
```

- A shape needs at least 2 points with strictly increasing times.
- Times are measured from the first point, so the first point plays at the trigger time.
- `releasePoint` is the point whose time defines the release tail's timing.
  `release()` holds the envelope's current value at note-off; it does not set the parameter
  to the release point's value. It then schedules each later point using its time difference
  from the release point. The release point's curve controls the first transition. `releasePoint`
  is independent of `sustainPoint`, though presets align them.
- Exponential segments can't reach zero, so any zero at either end is nudged to a tiny value.

An invalid shape throws a `TypeError`. Call `assertValidEnvelopeShape(shape)` to check one
yourself.

## Envelope

```ts
new Envelope(clock, param, shape);
```

- `clock` is anything with a `currentTime` in seconds, usually your `AudioContext`.
- `param` is any `AudioParam`, or an object that has the same automation methods.
- `shape` is copied, so later changes to your object don't affect the envelope.

### Playing

| Method                     | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `trigger(time?, options?)` | Starts the envelope. Re-triggering replaces the current run. |
| `release(time?)`           | Plays the release stage.                                     |
| `stop(time?)`              | Ends the run and holds the param where it is.                |

`time` is an `AudioContext` time and defaults to now. `trigger` and `release` clamp past
times to now; `stop` currently uses the supplied time directly. Stop does not currently
cancel an already-released tail; see [lifecycle follow-ups](KNOWN-ISSUES.md#scheduling-and-lifecycle).

A looping envelope keeps scheduling ahead on a timer until you call `release()` or `stop()`.

### Trigger options

| Option      | Default      | Meaning                                                                      |
| ----------- | ------------ | ---------------------------------------------------------------------------- |
| `base`      | `0`          | Param value when the shape reads 0.                                          |
| `amount`    | `1`          | How far the param moves per unit of shape. Negative values invert the shape. |
| `timeScale` | `1`          | Playback speed. `2` plays twice as fast.                                     |
| `shape`     | stored shape | Plays a different shape for this run only.                                   |
| `fromPoint` | `0`          | Loops only: start the first pass at this point index.                        |

The param follows `base + amount * pointValue`, so one shape can drive a gain (0 to 1), a
cutoff (200 to 8000 Hz) or anything else:

```ts
filterEnv.trigger(ctx.currentTime, { base: 200, amount: 7800 });
```

### Changing things

- `env.shape = newShape` replaces the stored shape. It applies from the next trigger, and a
  run that is already playing keeps its old shape.
- `env.setSustainValue(value, time?, glide = 0.02)` moves the sustain level while the note is
  held. It only works in `sustain` mode after the sustain point is reached, and otherwise
  does nothing.

The sampler also applies edits to running notes: existing loops retrigger at their next
boundary, enabling loop on a non-looping run picks up from its last reached point, and
held amplitude/pitch sustain levels can glide. Filter sustain edits wait for a trigger.
These live-edit behaviors are retained but provisional; their limitations are tracked
in [live edits](KNOWN-ISSUES.md#live-edits).

### Reading state

| Method                 | Returns                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `duration()`           | Length of the latest run's shape at its time scale; stored shape at scale 1 before any run.   |
| `releaseDuration()`    | Length of the release stage in seconds.                                                       |
| `position(time?)`      | Seconds from the first point, wrapped for loops and held at sustain; null after release/stop. |
| `currentPoint(time?)`  | Index of the last point reached, or `null` when nothing is playing or the shape loops.        |
| `nextCycleTime(time?)` | Start time of the next loop cycle, or `null` if the envelope isn't looping.                   |

One-shot position currently continues past the final point. Release tails have no reported
position; these accessors are not completion notifications.

## Presets

Each preset takes a total duration in seconds (default `1`) and returns a shape.

```ts
import { envelopePresets } from '@kidlib/web-audio';

envelopePresets.amplitude(2); // attack, decay, sustain, release
envelopePresets.filter(0.5); // quick sweep up, then back down, plays once
```

## Internal helpers

These are available inside the source module, not exported from the package root.

- `setDuration(points, seconds)` returns new points stretched to a total length.
- `hasVariation(points)` returns `false` if every point has the same value (within 0.001).

```ts
const longer = { ...shape, points: setDuration(shape.points, 4) };
```
