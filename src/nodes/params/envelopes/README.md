# envelopes

Breakpoint envelopes for Web Audio. Draw a shape out of points, bind it to an `AudioParam`,
then trigger and release it.

```ts
import { Envelope } from 'envelopes';

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
  sustain: 2,
  release: 2,
});

env.trigger(); // note on
env.release(); // note off
```

## Shape

```ts
type EnvelopeShape = {
  points: EnvelopePoint[];
  mode: EnvelopeMode;
  sustain: number;
  release: number;
};

type EnvelopePoint = {
  time: number; // seconds
  value: number;
  curve?: 'linear' | 'exponential' | 'step'; // curve to the next point, default 'linear'
};

type EnvelopeMode =
  | { type: 'once' } // play through to the end
  | { type: 'sustain' } // stop at `sustain` and hold until release
  | { type: 'loop' }; // repeat the whole shape until release
```

- A shape needs at least 2 points, sorted by time.
- Times are measured from the first point, so the first point plays at the trigger time.
- `release` is the tail's timing anchor. `release()` pins the current value, then schedules
  the points after that index at offsets from its time; its curve controls the first segment,
  but its value is not replayed. It is independent of `sustain`, though presets align them.
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

`time` is an `AudioContext` time and defaults to now. A time in the past counts as now.

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

### Reading state

| Method                 | Returns                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `duration()`           | Length of the whole shape in seconds, at the current `timeScale`.                      |
| `releaseDuration()`    | Length of the release stage in seconds.                                                |
| `position(time?)`      | Seconds into the shape, or `null` when nothing is playing.                             |
| `currentPoint(time?)`  | Index of the last point reached, or `null` when nothing is playing or the shape loops. |
| `nextCycleTime(time?)` | Start time of the next loop cycle, or `null` if the envelope isn't looping.            |

## Presets

Each preset takes a total duration in seconds (default `1`) and returns a shape.

```ts
import { envelopePresets } from 'envelopes';

envelopePresets.amplitude(2); // attack, decay, sustain, release
envelopePresets.filter(0.5); // quick sweep up, then back down, plays once
```

## Helpers

- `setDuration(points, seconds)` returns new points stretched to a total length.
- `hasVariation(points)` returns `false` if every point has the same value (within 0.001).

```ts
const longer = { ...shape, points: setDuration(shape.points, 4) };
```
