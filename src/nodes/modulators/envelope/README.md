# envelopes

Breakpoint envelopes for Web Audio. Draw a shape out of points, bind it to an `AudioParam`,
then trigger and release it. See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for all deferred work.

`Envelope` owns parameter scheduling and per-trigger snapshots. `SamplePlayer` owns
editable configs; `SampleVoice` applies them using
[`sample-envelope-policy.ts`](../../instruments/Sample/sample-envelope-policy.ts) for
defaults, parameter mapping and trigger options. Live-edit decisions stay in `SampleVoice`.

```ts
import { Envelope } from '@/nodes/modulators/envelope';

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

`time` is an `AudioContext` time and defaults to now. `trigger`, `release`, and `stop` clamp
past times to now. Stop also cancels an already-released tail, holding its scheduled value
at the stop time.

A looping envelope keeps scheduling ahead on a timer until you call `release()` or `stop()`.

### Trigger options

| Option      | Default      | Meaning                                                                      |
| ----------- | ------------ | ---------------------------------------------------------------------------- |
| `base`      | `0`          | Param value when the shape reads 0.                                          |
| `depth`     | `1`          | How far the param moves per unit of shape. Negative values invert the shape. |
| `timeScale` | `1`          | Playback speed. `2` plays twice as fast.                                     |
| `shape`     | stored shape | Plays a different shape for this run only.                                   |
| `fromPoint` | `0`          | Loops only: start the first pass at this point index.                        |
| `curve`     | shape curves | Overrides ramp curves for the run, preserving steps.                         |

The param follows `base + depth * pointValue`, so one shape can drive a gain (0 to 1), a
cutoff (200 to 8000 Hz) or anything else:

```ts
filterEnv.trigger(ctx.currentTime, { base: 200, depth: 7800 });
```

### Modulating a param someone else controls

The envelope owns the param it is bound to, so a knob writing that same param fights it,
and a release hands off from the envelope's value, not the knob's. Bind the envelope to a
separate input instead. Web Audio sums signals connected to an `AudioParam` with its own
value, and a `BiquadFilterNode` multiplies `frequency` by `2^(detune / 1200)`, so a
filter envelope in cents leaves `frequency` free for the cutoff knob:

```ts
const filterEnv = new Envelope(ctx, filter.detune, shape);
filterEnv.trigger(t, { depth: 1200 * 4, curve: 'linear' }); // up to 4 octaves above the cutoff
filter.frequency.setTargetAtTime(knobHz, ctx.currentTime, 0.01); // safe at any stage
```

Linear ramps in cents are exponential in Hz, so the sweep already sounds even.

### Changing things

- `env.shape = newShape` replaces the stored shape. It applies from the next trigger, and a
  run that is already playing keeps its old shape.
- `env.setSustainValue(value, time?, glide = 0.02)` moves the sustain level while the note is
  held. It only works in `sustain` mode after the sustain point is reached, and otherwise
  does nothing.

The sampler also applies edits to running notes: existing loops retrigger at their next
boundary, enabling loop on a non-looping run picks up from its last reached point, and
held sustain levels can glide.
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
import { envelopePresets } from '@/nodes/modulators/envelope';

envelopePresets.amplitude(2); // attack, decay, sustain, release
envelopePresets.filter(0.5); // quick sweep up, then back down, plays once
```

## Duration helpers

These helpers are exported from the package root and the internal envelope module.

- `getDuration(points)` returns the sum of segment durations in seconds: last time minus
  first time. Indefinite sustain holds and loop repetitions are excluded.
- `setDuration(points, seconds)` returns new points scaled proportionally to that length,
  preserving the first point's time, values and curves. Seconds must be finite and positive.

```ts
import { getDuration, setDuration } from '@kidlib/web-audio';

const longer = { ...shape, points: setDuration(shape.points, 4) };
getDuration(longer.points); // 4
```

SamplePlayer can resize an envelope through its existing update API:

```ts
player.updateEnvelope('amp', { duration: 2 });
getDuration(player.getEnvelope('amp').shape.points); // 2
```

`duration` scales the resulting shape, including a replacement `shape` supplied in the
same patch. It is an update instruction, not a second stored config field. `timeScale`
and playback-rate synchronization still affect playback independently: a two-second
shape at `timeScale: 2` plays in one second. `Envelope.duration()` reports the latest
run's scaled duration, which can differ from the edited shape's duration.

Duration updates use the same live-edit rules as other shape edits. Loading another
sample still resizes shapes to its buffer duration; reset still sizes defaults to the
current sample.

`depth` and `base` use the destination parameter's units (gain, Hz, cents, etc.);
shape values are unitless. Negative depth inverts the shape around `base`.
Depth and base must be finite.

Sampler envelope configs instead expose a unitless depth multiplier: 1 maps to
1 gain unit, 1200 cents for pitch, or 12000 cents for filter detune.

LFO depth also uses destination units, but its signal adds to the AudioParam's
existing value; Envelope writes the parameter's automation directly. Sampler AM
controls retain their existing normalized 0–1 range and mapping.
