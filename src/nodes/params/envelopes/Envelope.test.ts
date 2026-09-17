import { afterEach, describe, expect, it, test, vi } from 'vite-plus/test';
import {
  createEnvelopeScheduler,
  interpolateAtTime,
  releaseEnvelope,
  scheduleEnvelope,
  type Envelope,
} from './Envelope';
import { createFakeParam } from './fakeParam';

afterEach(() => vi.useRealTimers());

function mockParam() {
  const calls = {
    set: vi.fn(),
    linear: vi.fn(),
    exponential: vi.fn(),
    hold: vi.fn(),
  };
  const param = {
    value: 0,
    setValueAtTime: calls.set,
    linearRampToValueAtTime: calls.linear,
    exponentialRampToValueAtTime: calls.exponential,
    // `cancelAndPinParamValue` stands in for cancelAndHoldAtTime, which Firefox has
    // not shipped. The cancel is the hold, so that is what `hold` counts here.
    cancelScheduledValues: calls.hold,
  } as unknown as AudioParam;

  return { calls, param };
}

test('schedules through sustain, then schedules the remaining points on release', () => {
  const { calls, param } = mockParam();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1, curve: 'exponential' },
      { time: 0.3, value: 0.5 },
      { time: 0.8, value: 0 },
    ],
    sustain: 2,
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10);

  expect(calls.set).toHaveBeenCalledWith(0, 10);
  expect(calls.linear).toHaveBeenCalledWith(1, 10.1);
  expect(calls.exponential).toHaveBeenCalledWith(0.5, 10.3);
  expect(calls.linear).not.toHaveBeenCalledWith(0, 10.8);

  releaseEnvelope(param, envelope, 20);

  expect(calls.hold).toHaveBeenCalledWith(20);
  expect(calls.linear).toHaveBeenCalledWith(0, 20.5);
});

test('treats point times as offsets from the first point, not as a pre-delay', () => {
  const { calls, param } = mockParam();
  const envelope: Envelope = {
    points: [
      { time: 0.5, value: 0 },
      { time: 0.6, value: 1 },
      { time: 0.9, value: 0.25 },
    ],
    sustain: 2,
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10);

  // Point 0 on the trigger time, same as the looped path does.
  expect(calls.set).toHaveBeenCalledWith(0, 10);
  expect(calls.linear).toHaveBeenCalledWith(1, 10 + (0.6 - 0.5));
});

// Common amplitude and filter presets use exponential segments that touch zero.
// throughout, zero at both ends. A zero target throws, a zero start silently holds.
test('keeps an exponential segment off zero at both ends', () => {
  const { calls, param } = mockParam();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0, curve: 'exponential' },
      { time: 0.005, value: 1, curve: 'exponential' },
      { time: 0.9, value: 0.5, curve: 'exponential' },
      { time: 1, value: 0, curve: 'exponential' },
    ],
    sustain: 2,
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10, { amount: 20000 });

  // A fraction of the amount, so it lands at the same depth whatever the range.
  expect(calls.set).toHaveBeenCalledWith(1e-4 * 20000, 10);
  expect(calls.exponential).toHaveBeenCalledWith(20000, 10.005);

  releaseEnvelope(param, envelope, 20, { amount: 20000 });

  expect(calls.exponential).toHaveBeenCalledWith(1e-4 * 20000, 20.1);
});

test('leaves values alone when no exponential segment touches them', () => {
  const { calls, param } = mockParam();

  scheduleEnvelope(
    param,
    {
      points: [
        { time: 0, value: 0, curve: 'linear' },
        { time: 0.02, value: 1, curve: 'exponential' },
        { time: 0.3, value: 0, curve: 'linear' },
      ],
      sustain: 2,
      release: 2,
    },
    10,
  );

  // Point 0 is only a linear endpoint, so it stays at a true zero.
  expect(calls.set).toHaveBeenCalledWith(0, 10);
  // Point 2 is the exponential's target, so it is floored.
  expect(calls.exponential).toHaveBeenCalledWith(1e-4, 10.3);
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
    sustain: 2,
    release: 2,
  };

  const scheduled = (options?: { base?: number; amount?: number }) => {
    const { calls, param } = mockParam();
    scheduleEnvelope(param, envelope, 0, options);
    return [
      calls.set.mock.calls[0][0],
      ...calls.linear.mock.calls.map(([value]) => value as number),
    ];
  };

  expect(scheduled()).toEqual([0, 1, 0.5]);
  expect(scheduled({ amount: 0.5 })).toEqual([0, 0.5, 0.25]);
  expect(scheduled({ base: 500, amount: 8000 })).toEqual([500, 8500, 4500]);
  // A negative amount inverts the shape around the base.
  expect(scheduled({ base: 1, amount: -0.5 })).toEqual([1, 0.5, 0.75]);
});

test('keeps an inverted exponential envelope on its own side of zero', () => {
  const { calls, param } = mockParam();

  scheduleEnvelope(
    param,
    {
      points: [
        { time: 0, value: 0, curve: 'exponential' },
        { time: 0.1, value: 1, curve: 'exponential' },
      ],
      sustain: 1,
      release: 1,
    },
    0,
    { amount: -1 },
  );

  // Point 0 lands on zero, so it is floored away from it without crossing over.
  expect(calls.set).toHaveBeenCalledWith(-1e-4, 0);
  expect(calls.exponential).toHaveBeenCalledWith(-1, 0.1);
});

test('anchors every rolling loop cycle to the original trigger time', () => {
  vi.useFakeTimers();
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const context = clock as AudioContext;
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0 },
    ],
    sustain: 2,
    release: 1,
    loop: true,
  };
  const env = createEnvelopeScheduler(context, param, envelope);

  env.trigger(0);
  clock.currentTime = 2.02;
  vi.advanceTimersByTime(50);

  expect(calls.linear.mock.calls.some(([value, time]) => value === 1 && time === 0.1)).toBe(true);
  expect(
    calls.linear.mock.calls.some(
      ([value, time]) => value === 1 && Math.abs((time as number) - 2.1) < 1e-10,
    ),
  ).toBe(true);

  env.dispose();
});

test('scheduler release stops its loop and schedules the scaled release stage', () => {
  vi.useFakeTimers();
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0.5 },
      { time: 0.5, value: 0.2 },
    ],
    sustain: 2,
    release: 2,
    loop: true,
  };
  const env = createEnvelopeScheduler(clock as AudioContext, param, envelope);

  env.trigger(0, { amount: 0.5 });
  env.release(0.25);

  expect(calls.linear).toHaveBeenCalledWith(0.1, 0.55);

  const scheduledCalls = calls.set.mock.calls.length + calls.linear.mock.calls.length;
  clock.currentTime = 2;
  vi.advanceTimersByTime(50);
  expect(calls.set.mock.calls.length + calls.linear.mock.calls.length).toBe(scheduledCalls);

  env.dispose();
});

// A sampler lines buffer playback up with the envelope by starting both at one
// timestamp, so every cycle must open on that timestamp plus a whole number of
// periods. No pre-loop stage, and no dependence on where point 0 sits in time.
test('opens every loop cycle on the trigger time plus a whole number of periods', () => {
  vi.useFakeTimers();
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0.5, value: 0 },
      { time: 0.6, value: 1 },
      { time: 0.9, value: 0.25 },
    ],
    sustain: 2,
    release: 2,
    loop: true,
  };
  const env = createEnvelopeScheduler(clock as AudioContext, param, envelope);

  env.trigger(4);
  clock.currentTime = 4.5;
  vi.advanceTimersByTime(50);

  // Span is 0.4 s, so cycles open at 4, 4.4, 4.8, ... regardless of points[0].time.
  // Deduped: the pin on trigger writes at the same instant cycle 0 opens.
  const opens = [...new Set(calls.set.mock.calls.map(([, time]) => time as number))].sort(
    (a, b) => a - b,
  );
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
    // `loop` takes the place of `sustain` rather than combining with it, and this test
    // never releases, so pointing `release` at the last point leaves that stage empty.
    release: 2,
    loop: true,
  };
  const env = createEnvelopeScheduler(clock as AudioContext, param, envelope);

  env.trigger(0.1);

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
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.4, value: 0.5 },
      { time: 1.4, value: 0 },
    ],
    release: 2,
    loop: true,
  };
  const env = createEnvelopeScheduler(clock as AudioContext, param, envelope);

  env.trigger(0);

  expect(calls.linear.mock.calls.some(([value]) => value === 0)).toBe(true);

  // Release exits the loop and plays the tail from wherever the loop was.
  env.release(0.9);
  expect(calls.linear).toHaveBeenCalledWith(0, 1.9);

  const scheduled = calls.set.mock.calls.length + calls.linear.mock.calls.length;
  clock.currentTime = 3;
  vi.advanceTimersByTime(50);
  expect(calls.set.mock.calls.length + calls.linear.mock.calls.length).toBe(scheduled);

  env.dispose();
});

test('loops the whole envelope when no sustain point is set', () => {
  vi.useFakeTimers();
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const env = createEnvelopeScheduler(clock as AudioContext, param, {
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ],
    release: 1,
    loop: true,
  });

  env.trigger(0);
  clock.currentTime = 0.1;
  vi.advanceTimersByTime(50);
  expect(calls.set.mock.calls.some(([, time]) => time === 1)).toBe(true);
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
  const { calls, param } = mockParam();
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 0.2, value: 0.5 },
      { time: 0.6, value: 0 },
    ],
    sustain: 2,
    release: 2,
  };

  scheduleEnvelope(param, envelope, 10, { timeScale: 2 });
  expect(calls.linear).toHaveBeenCalledWith(1, 10.05);
  expect(calls.linear).toHaveBeenCalledWith(0.5, 10.1);

  releaseEnvelope(param, envelope, 20, { timeScale: 2 });
  expect(calls.linear).toHaveBeenCalledWith(0, 20.2);
});

// A sampler amp envelope decays on its own while the note is held and still has a
// tail on note-off. A lone sustain cannot express that: it holds where this keeps
// moving. So the release index has to work without one.
test('a release index without a sustain plays through and still has a tail', () => {
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.1, value: 1 },
      { time: 1.1, value: 0.2 },
      { time: 1.3, value: 0 },
    ],
    release: 2,
  };
  const env = createEnvelopeScheduler(clock as AudioContext, param, envelope);

  // No sustain, so the whole shape is scheduled up front, tail included.
  env.trigger(0);
  expect(calls.linear).toHaveBeenCalledWith(0, 1.3);

  // Releasing mid-decay hands off the shape's own value there, not param.value.
  calls.set.mockClear();
  env.release(0.6);
  expect(calls.set).toHaveBeenCalledWith(0.6, 0.6);
  const tail = calls.linear.mock.calls.at(-1) as [number, number];
  expect(tail[0]).toBe(0);
  expect(tail[1]).toBeCloseTo(0.8, 10);

  env.dispose();
});

// Loop switched on while a note is parked on its sustain point: the first pass carries
// on from there, and the full cycles after it sit on the grid point 0 would have had.
test('opens a fromPoint run mid-shape and anchors its cycles on point 0', () => {
  vi.useFakeTimers();
  const { calls, param } = mockParam();
  const clock = { currentTime: 0 };
  const envelope: Envelope = {
    points: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.4, value: 0.5 },
      { time: 1, value: 0 },
    ],
    sustain: 1,
    release: 2,
    loop: true,
  };
  const env = createEnvelopeScheduler(clock as AudioContext, param, envelope);

  env.trigger(4, { fromPoint: 1 });

  // The opening pass runs sustain -> end: no attack, and nothing scheduled before 4.
  expect(calls.set).toHaveBeenCalledWith(1, 4);
  expect(calls.linear).toHaveBeenCalledWith(0.5, 4.2);
  expect(calls.linear).toHaveBeenCalledWith(0, 4.8);
  const times = [...calls.set.mock.calls, ...calls.linear.mock.calls].map(([, t]) => t as number);
  expect(Math.min(...times)).toBeCloseTo(4, 10);

  clock.currentTime = 5;
  vi.advanceTimersByTime(50);

  // Anchor is 3.8 (point 0's virtual time), so full cycles open at 4.8, 5.8, ...
  const opens = [...new Set(calls.set.mock.calls.map(([, time]) => time as number))].sort(
    (a, b) => a - b,
  );
  expect(opens[0]).toBeCloseTo(4, 10);
  expect(opens[1]).toBeCloseTo(4.8, 10);
  expect(opens[2]).toBeCloseTo(5.8, 10);

  env.dispose();
});
