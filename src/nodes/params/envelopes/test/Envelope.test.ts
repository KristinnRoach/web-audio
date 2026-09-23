import { afterEach, describe, expect, it, test, vi } from 'vite-plus/test';
import { Envelope } from '../Envelope';
import { releaseEnvelope, scheduleEnvelope } from '../envelope-scheduling';
import type { EnvelopeShape } from '../envelope-shape';
import { createFakeParam } from './fakeParam';

afterEach(() => vi.useRealTimers());

test('schedules through sustain, then schedules the remaining points on release', () => {
  const param = createFakeParam();
  const envelope: EnvelopeShape = {
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
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 1,
    time: 10.1,
  });
  expect(param.ramps()).toContainEqual({
    type: 'exponential',
    value: 0.5,
    time: 10.3,
  });
  expect(param.ramps()).not.toContainEqual({
    type: 'linear',
    value: 0,
    time: 10.8,
  });

  releaseEnvelope(param, envelope, 20);

  expect(param.events).toContainEqual({ type: 'cancel', time: 20 });
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 0,
    time: 20.5,
  });
});

test('treats point times as offsets from the first point, not as a pre-delay', () => {
  const param = createFakeParam();
  const envelope: EnvelopeShape = {
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
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 1,
    time: 10 + (0.6 - 0.5),
  });
});

// Common amplitude and filter presets use exponential segments that touch zero.
// throughout, zero at both ends. A zero target throws, a zero start silently holds.
test('keeps an exponential segment off zero at both ends', () => {
  const param = createFakeParam();
  const envelope: EnvelopeShape = {
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
  expect(param.ramps()).toContainEqual({
    type: 'set',
    value: 1e-4 * 20000,
    time: 10,
  });
  expect(param.ramps()).toContainEqual({
    type: 'exponential',
    value: 20000,
    time: 10.005,
  });

  releaseEnvelope(param, envelope, 20, { amount: 20000 });

  expect(param.ramps()).toContainEqual({
    type: 'exponential',
    value: 1e-4 * 20000,
    time: 20.1,
  });
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
  expect(param.ramps()).toContainEqual({
    type: 'exponential',
    value: 1e-4,
    time: 10.3,
  });
});

// param = base + amount * value, so the same shape drives a gain, a cutoff sweeping
// up from a resting frequency, or a rate falling below one.
test("places the shape on the parameter's range with base and amount", () => {
  const envelope: EnvelopeShape = {
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
  expect(param.ramps()).toContainEqual({
    type: 'exponential',
    value: -1,
    time: 0.1,
  });
});

test('anchors every rolling loop cycle to the original trigger time', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);

  env.trigger(0);
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

  env.stop();
});

test('player release stops its loop and schedules the scaled release stage', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0.5 },
      { time: 0.5, value: 0.2 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);

  env.trigger(0, { amount: 0.5 });
  env.release(0.25);

  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 0.1,
    time: 0.55,
  });

  const scheduledCalls = param.ramps().length;
  clock.currentTime = 2;
  vi.advanceTimersByTime(50);
  expect(param.ramps().length).toBe(scheduledCalls);

  env.stop();
});

// A sampler lines buffer playback up with the envelope by starting both at one
// timestamp, so every cycle must open on that timestamp plus a whole number of
// periods. No pre-loop stage, and no dependence on where point 0 sits in time.
test('opens every loop cycle on the trigger time plus a whole number of periods', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0.5, value: 0 },
      { time: 0.6, value: 1 },
      { time: 0.9, value: 0.25 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);

  env.trigger(4);
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

  env.stop();
});

// The grid test above runs four cycles, which is too few for an accumulating error to
// show. The `Math.max(grid, cycleEnd)` guard in `trigger` is a ratchet: it can only ever
// push a cycle later, never back, so a per-cycle rounding error would compound rather
// than cancel. This pins the total over three thousand cycles of a short envelope, the
// worst case for accumulation since it is the most cycles per second.
//
// Budget is one sample at 48 kHz (2.08e-5 s), which is inaudible and still five orders
// of magnitude above the ~1e-12 s the ratchet actually reaches. It is a guard against a
// regression that makes cycle length and cycle placement round differently, not a claim
// that the current error is near the limit.
test('keeps loop cycles on the trigger grid over thousands of cycles', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0.1 };
  const span = 0.007;
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0, curve: 'linear' },
      { time: span * 0.1, value: 1, curve: 'linear' },
      { time: span, value: 0.2, curve: 'linear' },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);
  env.trigger(0.1);

  for (let tick = 0; tick < 400; tick++) {
    clock.currentTime += 0.05;
    vi.advanceTimersByTime(50);
  }

  const opens = param
    .ramps()
    .filter((event) => event.type === 'set')
    .map((event) => event.time);
  env.stop();

  expect(opens.length).toBeGreaterThan(2000);
  const worst = Math.max(...opens.map((time, cycle) => Math.abs(time - (0.1 + cycle * span))));
  expect(worst, `${opens.length} cycles drifted by ${worst.toExponential(3)} s`).toBeLessThan(
    1 / 48000,
  );
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
  const envelope: EnvelopeShape = {
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
  const env = new Envelope(clock, param, envelope);

  env.trigger(0.1);

  // Past the durations where the rounding flips, which for 0.3 s first happens at t = 1.
  for (let tick = 0; tick < 200; tick++) {
    clock.currentTime += 0.05;
    vi.advanceTimersByTime(50);
  }

  // `ramps()` drops the cancels, and cycle 0 opens with its own `set`, so this is whole
  // cycles as-is. Read it before stop, which pins once more.
  const cycles = param.ramps();
  env.stop();

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
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.4, value: 0.5 },
      { time: 1.4, value: 0 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);

  env.trigger(0);

  expect(param.ramps().some((e) => e.type === 'linear' && e.value === 0)).toBe(true);

  // Release exits the loop and plays the tail from wherever the loop was.
  env.release(0.9);
  expect(param.ramps()).toContainEqual({ type: 'linear', value: 0, time: 1.9 });

  const scheduled = param.ramps().length;
  clock.currentTime = 3;
  vi.advanceTimersByTime(50);
  expect(param.ramps().length).toBe(scheduled);

  env.stop();
});

test('loop mode repeats the whole envelope', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);

  env.trigger(0);
  clock.currentTime = 0.1;
  vi.advanceTimersByTime(50);
  expect(param.ramps().some((e) => e.type === 'set' && e.time === 1)).toBe(true);
  env.stop();
});

// timeScale divides point times, so it is the same knob a sampler uses to make the
// envelope stretch with playback rate. It has to reach the release stage too.
test('timeScale speeds up both the sustaining stage and the release', () => {
  const param = createFakeParam();
  const envelope: EnvelopeShape = {
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
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 1,
    time: 10.05,
  });
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 0.5,
    time: 10.1,
  });

  releaseEnvelope(param, envelope, 20, { timeScale: 2 });
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 0,
    time: 20.2,
  });
});

// A sampler amp envelope decays on its own while the note is held and still has a
// tail on note-off. A lone sustain cannot express that: it holds where this keeps
// moving. So the release index has to work without one.
test('once mode plays through and still has a release tail', () => {
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 1.1, value: 0.2 },
      { time: 1.3, value: 0 },
    ],
    mode: { type: 'once' },
    release: 2,
  };
  const env = new Envelope(clock, param, envelope);

  // Once mode schedules the whole shape up front, tail included.
  env.trigger(0);
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

  env.stop();
});

// Loop switched on while a note is parked on its sustain point: the first pass carries
// on from there, and the full cycles after it sit on the grid point 0 would have had.
test('opens a fromPoint run mid-shape and anchors its cycles on point 0', () => {
  vi.useFakeTimers();
  const param = createFakeParam();
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.4, value: 0.5 },
      { time: 1, value: 0 },
    ],
    release: 2,
    mode: { type: 'loop' },
  };
  const env = new Envelope(clock, param, envelope);

  env.trigger(4, { fromPoint: 1 });

  // The opening pass runs sustain -> end: no attack, and nothing scheduled before 4.
  expect(param.ramps()).toContainEqual({ type: 'set', value: 1, time: 4 });
  expect(param.ramps()).toContainEqual({
    type: 'linear',
    value: 0.5,
    time: 4.2,
  });
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

  env.stop();
});

test('an envelope player owns its envelope shape', () => {
  const clock = { currentTime: 0 };
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ],
    mode: { type: 'sustain', at: 1 },
    release: 1,
  };
  const envPlayer = new Envelope(clock, createFakeParam(), envelope);

  envPlayer.trigger(0);
  clock.currentTime = 1;
  envPlayer.setSustainValue(0.25);

  expect(envelope.points[1].value).toBe(1);
});

test('an envelope player rejects an empty envelope', () => {
  expect(
    () =>
      new Envelope({ currentTime: 0 }, createFakeParam(), {
        points: [],
        mode: { type: 'once' },
        release: 0,
      }),
  ).toThrow('Invalid envelope');
});

test('a future pickup hands over no earlier than its scheduled opening', () => {
  vi.useFakeTimers();
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
      { time: 2, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  const player = new Envelope({ currentTime: 0 }, createFakeParam(), envelope);

  player.trigger(4, { fromPoint: 1, timeScale: 2 });

  expect(player.nextCycleTime(0)).toBe(4);
  expect(player.nextCycleTime(3.75)).toBe(4);
  expect(player.nextCycleTime(4)).toBe(4.5);
  expect(player.nextCycleTime(4.5)).toBe(5.5);
  expect(player.position(4)).toBe(1);
  player.stop();
});

describe('Envelope lifecycle', () => {
  const envelope: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ],
    mode: { type: 'once' },
    release: 0,
  };

  it('can trigger again after stop', () => {
    const param = createFakeParam();
    const player = new Envelope({ currentTime: 0 }, param, envelope);

    player.trigger(0);
    player.stop(0.25);
    expect(player.position(0.25)).toBeNull();

    player.trigger(1);
    expect(player.position(1)).toBe(0);
    expect(param.ramps()).toContainEqual({ type: 'set', value: 0, time: 1 });
    player.stop();
  });

  it('leaves the active run unchanged when a trigger is invalid', () => {
    const param = createFakeParam();
    const player = new Envelope({ currentTime: 0 }, param, envelope);

    player.trigger(0);
    const eventCount = param.events.length;

    expect(() => player.trigger(0.5, { shape: { ...envelope, release: 9 } })).toThrow(
      'Invalid envelope',
    );
    expect(() => player.trigger(0.5, { timeScale: 0 })).toThrow(RangeError);
    expect(player.position(0.5)).toBe(0.5);
    expect(param.events).toHaveLength(eventCount);
    player.stop();
  });

  it('snapshots the shape it is given, and plays a new one from the next trigger', () => {
    const param = createFakeParam();
    const definition: EnvelopeShape = {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
      mode: { type: 'sustain', at: 1 },
      release: 1,
    };
    const player = new Envelope({ currentTime: 0 }, param, definition);

    player.trigger(0);
    (definition.points[1] as { value: number }).value = 0.25;
    player.release(1);
    expect(param.ramps().at(-1)).toEqual({ type: 'set', value: 1, time: 1 });

    // Setting the shape leaves the event list alone; the next trigger plays it.
    const before = param.events.length;
    player.shape = definition;
    expect(param.events).toHaveLength(before);

    player.trigger(2);
    player.release(3);
    expect(param.ramps().at(-1)).toEqual({ type: 'set', value: 0.25, time: 3 });
    player.stop();
  });

  it('clamps a trigger or release in the past to now', () => {
    const param = createFakeParam();
    const clock = { currentTime: 5 };
    const player = new Envelope(clock, param, {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      mode: { type: 'sustain', at: 1 },
      release: 1,
    });

    player.trigger(1);
    expect(param.ramps()[0]).toEqual({ type: 'set', value: 0, time: 5 });

    clock.currentTime = 7;
    player.release(6);
    expect(param.ramps()).toContainEqual({ type: 'set', value: 1, time: 7 });
    player.stop();
  });
});

describe('re-triggering one player', () => {
  const looping: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
      { time: 2, value: 0 },
    ],
    release: 1,
    mode: { type: 'loop' },
  };
  // Spans 0 to 1.5, with the release point at 1.
  const oneShot: EnvelopeShape = {
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0.5 },
      { time: 1.5, value: 0 },
    ],
    mode: { type: 'once' },
    release: 2,
  };

  it('rejects a shape without a mode or a release point', () => {
    const { mode: _mode, ...noMode } = oneShot;
    const { release: _release, ...noRelease } = oneShot;
    expect(
      () => new Envelope({ currentTime: 0 }, createFakeParam(), noMode as EnvelopeShape),
    ).toThrow('Invalid envelope');
    expect(
      () => new Envelope({ currentTime: 0 }, createFakeParam(), noRelease as EnvelopeShape),
    ).toThrow('Invalid envelope');
  });

  it('has no boundary to hand over on unless a loop is running', () => {
    const idle = new Envelope({ currentTime: 0 }, createFakeParam(), looping);
    expect(idle.nextCycleTime()).toBeNull();

    const once = new Envelope({ currentTime: 0 }, createFakeParam(), oneShot);
    once.trigger(0);
    expect(once.nextCycleTime()).toBeNull();
    once.stop();
  });

  it("puts the next cycle boundary ahead of now, on the trigger's grid", () => {
    vi.useFakeTimers();
    const clock = { currentTime: 0 };
    const player = new Envelope(clock, createFakeParam(), looping);
    player.trigger(0);

    expect(player.nextCycleTime()).toBe(2);
    clock.currentTime = 2;
    expect(player.nextCycleTime()).toBe(4);
    clock.currentTime = 2.5;
    expect(player.nextCycleTime()).toBe(4);
    player.stop();
  });

  it('re-triggers at the boundary without disturbing the cycle still playing', () => {
    vi.useFakeTimers();
    const clock = { currentTime: 0 };
    const param = createFakeParam();
    const player = new Envelope(clock, param, looping);
    player.trigger(0);

    clock.currentTime = 0.5;
    const at = player.nextCycleTime()!;
    expect(at).toBe(2);

    param.events.length = 0;
    player.trigger(at, { timeScale: 2 });

    // Nothing is cancelled or written before the handover, so the running cycle plays out.
    expect(param.events.every((event) => event.time >= at)).toBe(true);
    // The new run opens on the boundary at point 0, where the old cycle also would.
    expect(param.ramps()[0]).toMatchObject({ time: at, value: 0 });
    // Asking again before the handover arrives still answers the same seam.
    expect(player.nextCycleTime()).toBe(at);
    player.stop();
  });

  it('keeps every edit during a drag on the same boundary', () => {
    vi.useFakeTimers();
    const clock = { currentTime: 0 };
    const player = new Envelope(clock, createFakeParam(), looping);
    player.trigger(0);

    // An editor commits on each pointermove, so the boundary is asked for repeatedly
    // while it is still in the future. Every one of them is the same boundary.
    for (const now of [0.5, 0.55, 0.6, 1.4, 1.9]) {
      clock.currentTime = now;
      expect(player.nextCycleTime()).toBe(2);
      player.trigger(2);
    }

    clock.currentTime = 2.1;
    expect(player.nextCycleTime()).toBe(4);
    player.stop();
  });

  it('glides a held sustain to a new value and releases from it', () => {
    const clock = { currentTime: 0 };
    const param = createFakeParam();
    const player = new Envelope(clock, param, {
      ...oneShot,
      mode: { type: 'sustain', at: 1 },
      release: 1,
    });
    player.trigger(0);

    // Parked on sustain: point 1 lands at 0.5.
    clock.currentTime = 1;
    player.setSustainValue(0.25);
    expect(param.ramps().at(-1)).toEqual({ type: 'linear', value: 0.25, time: 1.02 });

    // The tail has to hand off from the edited value, not the one captured at trigger.
    // The glide's own pin sits at this same instant, so it is the last write that counts.
    player.release(1);
    const pins = param.ramps().filter((event) => event.type === 'set' && event.time === 1);
    expect(pins.at(-1)?.value).toBe(0.25);
  });

  it('keeps a released run released when a trigger is rejected', () => {
    const player = new Envelope({ currentTime: 0 }, createFakeParam(), oneShot);
    player.trigger(0);
    player.release(0);

    expect(() =>
      player.trigger(0, { shape: { ...oneShot, mode: { type: 'sustain', at: 9 } } }),
    ).toThrow('Invalid envelope');

    // Still released, so a second release stays the no-op it was.
    player.release(0);
    expect(player.currentPoint()).toBeNull();
  });

  it("reports the stored shape at scale 1 before any run, then the run's own scale", () => {
    const player = new Envelope({ currentTime: 0 }, createFakeParam(), oneShot);
    expect(player.duration()).toBeCloseTo(1.5);
    expect(player.releaseDuration()).toBeCloseTo(0.5);

    player.trigger(0, { timeScale: 3 });
    expect(player.duration()).toBeCloseTo(0.5);
    expect(player.releaseDuration()).toBeCloseTo(0.5 / 3);
    player.stop();
  });
});
