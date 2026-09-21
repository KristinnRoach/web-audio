import { afterEach, describe, expect, it, test, vi } from 'vite-plus/test';
import {
  createEnvelopePlayer,
  interpolateAtTime,
  releaseEnvelope,
  scheduleEnvelope,
  type Envelope,
} from '../Envelope';
import { createFakeParam } from './fakeParam';

afterEach(() => vi.useRealTimers());

test('schedules through sustain, then schedules the remaining points on release', () => {
  const param = createFakeParam();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1, curve: 'exponential' },
      { time: 0.3, value: 0.5 },
      { time: 0.8, value: 0 },
    ],
    mode: { type: 'sustain', at: 2 },
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10);

  expect(param.ramps()).toContainEqual({ type: 'set', value: 0, time: 10 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 1, time: 10.1 });
  expect(param.ramps()).toContainEqual({ type: 'exponential', value: 0.5, time: 10.3 });
  expect(param.ramps()).not.toContainEqual({ type: 'linear', value: 0, time: 10.8 });

  releaseEnvelope(param, envelope, 20);

  expect(param.events).toContainEqual({ type: 'cancel', time: 20 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0, time: 20.5 });
});

test('treats point times as offsets from the first point, not as a pre-delay', () => {
  const param = createFakeParam();
  const envelope: Envelope = {
    points: [
      { time: 0.5, value: 0 },
      { time: 0.6, value: 1 },
      { time: 0.9, value: 0.25 },
    ],
    mode: { type: 'sustain', at: 2 },
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10);

  // Point 0 on the trigger time, same as the looped path does.
  expect(param.ramps()).toContainEqual({ type: 'set', value: 0, time: 10 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 1, time: 10 + (0.6 - 0.5) });
});

// Common amplitude and filter presets use exponential segments that touch zero.
// throughout, zero at both ends. A zero target throws, a zero start silently holds.
test('keeps an exponential segment off zero at both ends', () => {
  const param = createFakeParam();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0, curve: 'exponential' },
      { time: 0.005, value: 1, curve: 'exponential' },
      { time: 0.9, value: 0.5, curve: 'exponential' },
      { time: 1, value: 0, curve: 'exponential' },
    ],
    mode: { type: 'sustain', at: 2 },
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10, { amount: 20000 });

  // A fraction of the amount, so it lands at the same depth whatever the range.
  expect(param.ramps()).toContainEqual({ type: 'set', value: 1e-4 * 20000, time: 10 });
  expect(param.ramps()).toContainEqual({ type: 'exponential', value: 20000, time: 10.005 });

  releaseEnvelope(param, envelope, 20, { amount: 20000 });

  expect(param.ramps()).toContainEqual({ type: 'exponential', value: 1e-4 * 20000, time: 20.1 });
});

test('leaves values alone when no exponential segment touches them', () => {
  const param = createFakeParam();

  scheduleEnvelope(
    param,
    {
      points: [
        { time: 0, value: 0, curve: 'linear' },
        { time: 0.02, value: 1, curve: 'exponential' },
        { time: 0.3, value: 0, curve: 'linear' },
      ],
      mode: { type: 'sustain', at: 2 },
      release: 2,
    },
    10,
  );

  // Point 0 is only a linear endpoint, so it stays at a true zero.
  expect(param.ramps()).toContainEqual({ type: 'set', value: 0, time: 10 });
  // Point 2 is the exponential's target, so it is floored.
  expect(param.ramps()).toContainEqual({ type: 'exponential', value: 1e-4, time: 10.3 });
});

// param = base + amount * value, so the same shape drives a gain, a cutoff sweeping
// up from a resting frequency, or a rate falling below one.
test("places the shape on the parameter's range with base and amount", () => {
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0.5 },
    ],
    mode: { type: 'sustain', at: 2 },
    release: 2,
  };

  const scheduled = (options?: { base?: number; amount?: number }) => {
    const param = createFakeParam();
    scheduleEnvelope(param, envelope, 0, options);
    return param.ramps().map((event) => event.value);
  };

  expect(scheduled()).toEqual([0, 1, 0.5]);
  expect(scheduled({ amount: 0.5 })).toEqual([0, 0.5, 0.25]);
  expect(scheduled({ base: 500, amount: 8000 })).toEqual([500, 8500, 4500]);
  // A negative amount inverts the shape around the base.
  expect(scheduled({ base: 1, amount: -0.5 })).toEqual([1, 0.5, 0.75]);
});

test('keeps an inverted exponential envelope on its own side of zero', () => {
  const param = createFakeParam();

  scheduleEnvelope(
    param,
    {
      points: [
        { time: 0, value: 0, curve: 'exponential' },
        { time: 0.1, value: 1, curve: 'exponential' },
      ],
      mode: { type: 'sustain', at: 1 },
      release: 1,
    },
    0,
    { amount: -1 },
  );

  // Point 0 lands on zero, so it is floored away from it without crossing over.
  expect(param.ramps()).toContainEqual({ type: 'set', value: -1e-4, time: 0 });
  expect(param.ramps()).toContainEqual({ type: 'exponential', value: -1, time: 0.1 });
});

test('anchors every rolling loop cycle to the original trigger time', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 0);
  clock.currentTime = 2.02;
  vi.advanceTimersByTime(50);

  expect(param.ramps().some((e) => e.type === 'linear' && e.value === 1 && e.time === 0.1)).toBe(
    true,
  );
  expect(
    param
      .ramps()
      .some((e) => e.type === 'linear' && e.value === 1 && Math.abs(e.time - 2.1) < 1e-10),
  ).toBe(true);

  env.dispose();
});

test('player release stops its loop and schedules the scaled release stage', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0.5 },
      { time: 0.5, value: 0.2 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 0, { amount: 0.5 });
  env.release(0.25);

  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0.1, time: 0.55 });

  const scheduledCalls = param.ramps().length;
  clock.currentTime = 2;
  vi.advanceTimersByTime(50);
  expect(param.ramps().length).toBe(scheduledCalls);

  env.dispose();
});

// A sampler lines buffer playback up with the envelope by starting both at one
// timestamp, so every cycle must open on that timestamp plus a whole number of
// periods. No pre-loop stage, and no dependence on where point 0 sits in time.
test('opens every loop cycle on the trigger time plus a whole number of periods', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0.5, value: 0 },
      { time: 0.6, value: 1 },
      { time: 0.9, value: 0.25 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 4);
  clock.currentTime = 4.5;
  vi.advanceTimersByTime(50);

  // Span is 0.4 s, so cycles open at 4, 4.4, 4.8, ... regardless of points[0].time.
  // Deduped: the pin on trigger writes at the same instant cycle 0 opens.
  const opens = [
    ...new Set(
      param
        .ramps()
        .filter((e) => e.type === 'set')
        .map((e) => e.time),
    ),
  ].sort((a, b) => a - b);
  expect(opens.length).toBeGreaterThan(3);
  opens.forEach((time, cycle) => expect(time).toBeCloseTo(4 + cycle * 0.4, 10));

  env.dispose();
});

// The test above places cycles on the grid to within 5e-11, which is the tolerance the
// guard below needs; this one is about the ULP underneath it. A cycle's opening
// `setValueAtTime` and the previous cycle's closing ramp are the same instant reached by
// two different sums, so they can land an ULP apart. Ordered the wrong way the ramp
// overwrites the reset and that pass loses its attack - audibly a skipped loop cycle, and
// only for some durations, since it is a rounding accident.
test('never opens a loop cycle before the previous one has closed', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0, curve: 'linear' },
      { time: 0.02, value: 1, curve: 'exponential' },
      { time: 0.3, value: 0.15, curve: 'linear' },
    ],
    // This test never releases, so pointing `release` at the last point leaves that
    // stage empty.
    release: 2,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 0.1);

  // Past the durations where the rounding flips, which for 0.3 s first happens at t = 1.
  for (let tick = 0; tick < 200; tick++) {
    clock.currentTime += 0.05;
    vi.advanceTimersByTime(50);
  }

  // `ramps()` drops the cancels, and cycle 0 opens with its own `set`, so this is whole
  // cycles as-is. Read it before dispose, which pins once more.
  const cycles = param.ramps();
  env.dispose();

  // Each cycle emits set, linear, exponential - the last of a triple closes it.
  expect(cycles.map((e) => e.type)).toEqual(
    cycles.map((_, index) => ['set', 'linear', 'exponential'][index % 3]),
  );
  expect(cycles.length / 3).toBeGreaterThan(20);

  for (let index = 3; index < cycles.length; index += 3) {
    expect(cycles[index - 1].time, `cycle ${index / 3} opens early`).toBeLessThanOrEqual(
      cycles[index].time,
    );
  }
});

test('release exits a whole-envelope loop and plays its release tail', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.4, value: 0.5 },
      { time: 1.4, value: 0 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 0);

  expect(param.ramps().some((e) => e.type === 'linear' && e.value === 0)).toBe(true);

  // Release exits the loop and plays the tail from wherever the loop was.
  env.release(0.9);
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0, time: 1.9 });

  const scheduled = param.ramps().length;
  clock.currentTime = 3;
  vi.advanceTimersByTime(50);
  expect(param.ramps().length).toBe(scheduled);

  env.dispose();
});

test('loop mode repeats the whole envelope', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 0);
  clock.currentTime = 0.1;
  vi.advanceTimersByTime(50);
  expect(param.ramps().some((e) => e.type === 'set' && e.time === 1)).toBe(true);
  env.dispose();
});

/**
 * Guards the release handoff: `interpolateAtTime` is what lets a release scheduled in
 * the future start from where the envelope will actually be, rather than from
 * `param.value`, which only ever answers for now.
 */
describe('interpolateAtTime', () => {
  const points = [
    { time: 0, value: 0, curve: 'linear' as const },
    { time: 1, value: 1, curve: 'exponential' as const },
    { time: 2, value: 0.25, curve: 'step' as const },
    { time: 3, value: 0 },
  ];

  it('clamps outside the shape instead of extrapolating', () => {
    expect(interpolateAtTime(points, -5)).toBe(0);
    expect(interpolateAtTime(points, 99)).toBe(0);
    expect(interpolateAtTime([], 1)).toBe(0);
  });

  it('returns point values exactly on the points', () => {
    expect(interpolateAtTime(points, 0)).toBe(0);
    expect(interpolateAtTime(points, 1)).toBe(1);
    expect(interpolateAtTime(points, 2)).toBe(0.25);
  });

  it("follows each segment's own curve", () => {
    expect(interpolateAtTime(points, 0.5)).toBeCloseTo(0.5); // linear
    expect(interpolateAtTime(points, 1.5)).toBeCloseTo(0.5); // exponential: 1 * 0.25^0.5
    expect(interpolateAtTime(points, 2.5)).toBe(0.25); // step holds the left value
  });

  it('falls back to linear where an exponential segment touches zero', () => {
    const throughZero = [
      { time: 0, value: 0, curve: 'exponential' as const },
      { time: 1, value: 1 },
    ];
    expect(interpolateAtTime(throughZero, 0.5)).toBeCloseTo(0.5);
  });

  it('survives coincident point times', () => {
    const stacked = [
      { time: 0, value: 0 },
      { time: 1, value: 0.5 },
      { time: 1, value: 1 },
      { time: 2, value: 0 },
    ];
    expect(Number.isFinite(interpolateAtTime(stacked, 1))).toBe(true);
  });
});

// timeScale divides point times, so it is the same knob a sampler uses to make the
// envelope stretch with playback rate. It has to reach the release stage too.
test('timeScale speeds up both the sustaining stage and the release', () => {
  const param = createFakeParam();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0.5 },
      { time: 0.6, value: 0 },
    ],
    mode: { type: 'sustain', at: 2 },
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10, { timeScale: 2 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 1, time: 10.05 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0.5, time: 10.1 });

  releaseEnvelope(param, envelope, 20, { timeScale: 2 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0, time: 20.2 });
});

// A sampler amp envelope decays on its own while the note is held and still has a
// tail on note-off. A lone sustain cannot express that: it holds where this keeps
// moving. So the release index has to work without one.
test('once mode plays through and still has a release tail', () => {
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 1.1, value: 0.2 },
      { time: 1.3, value: 0 },
    ],
    mode: { type: 'once' },
    release: 2,
  };
  const env = createEnvelopePlayer(clock, param);

  // Once mode schedules the whole shape up front, tail included.
  env.trigger(envelope, 0);
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0, time: 1.3 });

  // Releasing mid-decay hands off the shape's own value there, not param.value.
  param.events.length = 0;
  env.release(0.6);
  expect(param.ramps()).toContainEqual({ type: 'set', value: 0.6, time: 0.6 });
  const tail = param
    .ramps()
    .filter((e) => e.type === 'linear')
    .at(-1)!;
  expect(tail.value).toBe(0);
  expect(tail.time).toBeCloseTo(0.8, 10);

  env.dispose();
});

// Loop switched on while a note is parked on its sustain point: the first pass carries
// on from there, and the full cycles after it sit on the grid point 0 would have had.
test('opens a fromPoint run mid-shape and anchors its cycles on point 0', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.4, value: 0.5 },
      { time: 1, value: 0 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = createEnvelopePlayer(clock, param);

  env.trigger(envelope, 4, { fromPoint: 1 });

  // The opening pass runs sustain -> end: no attack, and nothing scheduled before 4.
  expect(param.ramps()).toContainEqual({ type: 'set', value: 1, time: 4 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0.5, time: 4.2 });
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0, time: 4.8 });
  const times = param.ramps().map((event) => event.time);
  expect(Math.min(...times)).toBeCloseTo(4, 10);

  clock.currentTime = 5;
  vi.advanceTimersByTime(50);

  // Anchor is 3.8 (point 0's virtual time), so full cycles open at 4.8, 5.8, ...
  const opens = [
    ...new Set(
      param
        .ramps()
        .filter((e) => e.type === 'set')
        .map((e) => e.time),
    ),
  ].sort((a, b) => a - b);
  expect(opens[0]).toBeCloseTo(4, 10);
  expect(opens[1]).toBeCloseTo(4.8, 10);
  expect(opens[2]).toBeCloseTo(5.8, 10);

  env.dispose();
});

test('an envelope player owns its envelope shape', () => {
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ],
    mode: { type: 'sustain', at: 1 },
    release: 1,
  };
  const envPlayer = createEnvelopePlayer(clock, createFakeParam());

  envPlayer.trigger(envelope, 0);
  clock.currentTime = 1;
  envPlayer.setSustainValue(0.25);

  expect(envelope.points[1].value).toBe(1);
});

test('an envelope player rejects an empty envelope', () => {
  const player = createEnvelopePlayer({ currentTime: 0 }, createFakeParam());

  expect(() =>
    player.trigger({
      points: [],
      mode: { type: 'once' },
      release: 0,
    }),
  ).toThrow('Invalid envelope');
  player.dispose();
});

test('a future pickup hands over no earlier than its scheduled opening', () => {
  vi.useFakeTimers();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
      { time: 2, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  const player = createEnvelopePlayer({ currentTime: 0 }, createFakeParam());

  player.trigger(envelope, 4, { fromPoint: 1, timeScale: 2 });

  expect(player.nextCycleTime(0)).toBe(4);
  expect(player.nextCycleTime(3.75)).toBe(4);
  expect(player.nextCycleTime(4)).toBe(4.5);
  expect(player.nextCycleTime(4.5)).toBe(5.5);
  expect(player.position(4)).toBe(1);
  player.dispose();
});

describe('EnvelopePlayer lifecycle', () => {
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ],
    mode: { type: 'once' },
    release: 0,
  };

  it('can trigger again after stop', () => {
    const param = createFakeParam();
    const player = createEnvelopePlayer({ currentTime: 0 }, param);

    player.trigger(envelope, 0);
    player.stop(0.25);
    expect(player.position(0.25)).toBeNull();

    player.trigger(envelope, 1);
    expect(player.position(1)).toBe(0);
    expect(param.ramps()).toContainEqual({ type: 'set', value: 0, time: 1 });
    player.dispose();
  });

  it('leaves the active run unchanged when a trigger is invalid', () => {
    const param = createFakeParam();
    const player = createEnvelopePlayer({ currentTime: 0 }, param);

    player.trigger(envelope, 0);
    const eventCount = param.events.length;

    expect(() => player.trigger({ ...envelope, release: 9 }, 0.5)).toThrow('Invalid envelope');
    expect(player.position(0.5)).toBe(0.5);
    expect(param.events).toHaveLength(eventCount);
    player.dispose();
  });

  it('cannot trigger after idempotent disposal', () => {
    const player = createEnvelopePlayer({ currentTime: 0 }, createFakeParam());

    player.trigger(envelope, 0);
    player.dispose();

    expect(() => player.dispose()).not.toThrow();
    expect(player.position()).toBeNull();
    expect(() => player.trigger(envelope, 1)).toThrow('disposed');
  });

  it('snapshots each envelope when triggered', () => {
    const param = createFakeParam();
    const definition: Envelope = {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
      mode: { type: 'sustain', at: 1 },
      release: 1,
    };
    const player = createEnvelopePlayer({ currentTime: 0 }, param);

    player.trigger(definition, 0);
    (definition.points[1] as { value: number }).value = 0.25;
    player.release(1);
    expect(param.ramps().at(-1)).toEqual({ type: 'set', value: 1, time: 1 });

    player.trigger(definition, 2);
    player.release(3);
    expect(param.ramps().at(-1)).toEqual({ type: 'set', value: 0.25, time: 3 });
    player.dispose();
  });
});
