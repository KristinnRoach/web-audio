import { describe, expect, it } from 'vite-plus/test';
import { createFakeParam } from './fakeParam';
import { EnvelopeRuntime } from '../EnvelopeRuntime';
import type { EnvelopeSettings } from '../Envelope';

function contextAt(currentTime: number) {
  return { currentTime };
}

function settingsOf(overrides: Partial<EnvelopeSettings> = {}): EnvelopeSettings {
  return {
    enabled: true,
    timeScale: 1,
    envelope: {
      points: [
        { time: 0, value: 0 },
        { time: 0.5, value: 1 },
        { time: 1, value: 0.5 },
        { time: 1.5, value: 0 },
      ],
      release: 2,
    },
    ...overrides,
  };
}

describe('EnvelopeRuntime validation', () => {
  it('requires a release point', () => {
    const settings = settingsOf() as unknown as {
      enabled: boolean;
      timeScale: number;
      envelope: { points: EnvelopeSettings['envelope']['points'] };
    };
    delete (settings.envelope as { release?: number }).release;

    expect(() => new EnvelopeRuntime(contextAt(0), settings as EnvelopeSettings)).toThrow(
      'Invalid envelope settings',
    );
  });
});

describe('EnvelopeRuntime live settings handover', () => {
  const looping = settingsOf({
    envelope: {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      release: 1,
      loop: true,
    },
  });

  it('has no boundary to hand over on unless a loop is running', () => {
    const idle = new EnvelopeRuntime(contextAt(0), looping);
    expect(idle.nextCycleTime()).toBeNull();

    const oneShot = new EnvelopeRuntime(contextAt(0), settingsOf());
    oneShot.trigger(createFakeParam(), 0);
    expect(oneShot.nextCycleTime()).toBeNull();
  });

  it("puts the next cycle boundary ahead of now, on the trigger's grid", () => {
    const context = contextAt(0);
    const runtime = new EnvelopeRuntime(context, looping);
    runtime.trigger(createFakeParam(), 0);

    expect(runtime.nextCycleTime()).toBe(2);
    context.currentTime = 2;
    expect(runtime.nextCycleTime()).toBe(4);
    context.currentTime = 2.5;
    expect(runtime.nextCycleTime()).toBe(4);
  });

  it('re-triggers at the boundary without disturbing the cycle still playing', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, looping);
    runtime.trigger(param, 0);

    context.currentTime = 0.5;
    const at = runtime.nextCycleTime();
    expect(at).toBe(2);

    runtime.applySettings({ ...looping, timeScale: 2 });
    param.events.length = 0;
    runtime.trigger(param, at!);

    // Nothing is cancelled or written before the handover, so the running cycle plays out.
    expect(param.events.every((event) => event.time >= at!)).toBe(true);
    // The new shape opens on the boundary at point 0, where the old cycle also would.
    expect(param.ramps()[0]).toMatchObject({ time: at, value: 0 });
    // Asking again before the handover arrives still answers the same seam.
    expect(runtime.nextCycleTime()).toBe(at);
  });
});

describe('EnvelopeRuntime repeated handovers', () => {
  const looping = settingsOf({
    envelope: {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      release: 1,
      loop: true,
    },
  });

  it('keeps every edit during a drag on the same boundary', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, looping);
    runtime.trigger(param, 0);

    // An editor commits on each pointermove, so the boundary is asked for repeatedly
    // while it is still in the future. Every one of them is the same boundary.
    for (const now of [0.5, 0.55, 0.6, 1.4, 1.9]) {
      context.currentTime = now;
      expect(runtime.nextCycleTime()).toBe(2);
      runtime.trigger(param, 2);
    }

    context.currentTime = 2.1;
    expect(runtime.nextCycleTime()).toBe(4);
  });
});

describe('live sustain value', () => {
  const sustaining = () =>
    settingsOf({ envelope: { ...settingsOf().envelope, sustain: 1, release: 1 } });

  it('glides to the new value and releases from it', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);

    // Parked on sustain: point 1 lands at 0.5.
    context.currentTime = 1;
    runtime.setSustainValue(0.25);
    expect(param.ramps().at(-1)).toEqual({ type: 'linear', value: 0.25, time: 1.02 });

    // The tail has to hand off from the edited value, not the one captured at trigger.
    // The glide's own pin sits at this same instant, so it is the last write that counts.
    runtime.release(1);
    const pins = param.ramps().filter((event) => event.type === 'set' && event.time === 1);
    expect(pins.at(-1)?.value).toBe(0.25);
  });

  it('keeps settings updates separate from the active player', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);

    context.currentTime = 1;
    const before = param.events.length;
    const edited = sustaining();
    const settings = {
      ...edited,
      envelope: {
        ...edited.envelope,
        points: edited.envelope.points.map((point, index) =>
          index === 1 ? { ...point, value: 0.25 } : point,
        ),
      },
    };
    runtime.applySettings(settings);

    expect(runtime.settings.envelope.points[1].value).toBe(0.25);
    expect(param.events.length).toBe(before);
  });
});

describe('EnvelopeRuntime.trigger validation', () => {
  it('rejects a caller-supplied shape with an out-of-range sustain', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    const bad = { ...settingsOf().envelope, sustain: 9 };

    expect(() => runtime.trigger(createFakeParam(), 0, { envelope: bad })).toThrow(
      'Invalid envelope settings',
    );
  });

  it('still accepts a valid caller-supplied shape', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    const mapped = settingsOf().envelope;

    expect(() =>
      runtime.trigger(createFakeParam(), 0, {
        envelope: {
          ...mapped,
          points: mapped.points.map((p) => ({ ...p, value: p.value * 8000 })),
        },
      }),
    ).not.toThrow();
  });
});

describe('EnvelopeRuntime.trigger leaves run state alone when it rejects', () => {
  const badShape = () => ({ ...settingsOf().envelope, sustain: 9 });

  it('keeps the active player running', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    runtime.trigger(createFakeParam(), 0);
    const before = runtime.position();

    expect(() => runtime.trigger(createFakeParam(), 0, { envelope: badShape() })).toThrow(
      'Invalid envelope settings',
    );

    expect(runtime.position()).toBe(before);
  });

  it('keeps a released run released', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    runtime.trigger(createFakeParam(), 0);
    runtime.release(0);

    expect(() => runtime.trigger(createFakeParam(), 0, { envelope: badShape() })).toThrow(
      'Invalid envelope settings',
    );

    // Still released, so a second release stays the no-op it was.
    runtime.release(0);
    expect(runtime.position()).toBeNull();
  });
});

describe('EnvelopeRuntime.position', () => {
  // settingsOf() points sit at 0, 0.5, 1 and 1.5.
  const at = (settings: EnvelopeSettings, currentTime: number, multiplier?: number) => {
    const context = contextAt(0);
    const runtime = new EnvelopeRuntime(context, settings);
    runtime.trigger(createFakeParam(), 0, { timeScaleMultiplier: multiplier });
    context.currentTime = currentTime;
    return runtime;
  };

  it('throws on a non-finite time, live run or not', () => {
    const idle = new EnvelopeRuntime(contextAt(0), settingsOf());
    expect(() => idle.position(NaN)).toThrow(RangeError);

    const live = at(settingsOf(), 0.5);
    expect(() => live.position(NaN)).toThrow(RangeError);
    expect(() => live.position(Infinity)).toThrow(RangeError);
  });

  it('is null with no live run', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    expect(runtime.position()).toBeNull();
  });

  it('is null once released, and once stopped', () => {
    const released = at(settingsOf(), 0.75);
    released.release(0.75);
    expect(released.position()).toBeNull();

    const stopped = at(settingsOf(), 0.75);
    stopped.stop();
    expect(stopped.position()).toBeNull();
  });

  it('reports seconds of envelope time, matching wall seconds only at timeScale 1', () => {
    expect(at(settingsOf(), 0.75).position()).toBeCloseTo(0.75);
  });

  it('scales wall seconds by the run timeScale', () => {
    // Twice speed: a quarter second of wall clock is half a second into the shape.
    expect(at(settingsOf({ timeScale: 2 }), 0.25).position()).toBeCloseTo(0.5);
  });

  it('folds the host multiplier into the same scale', () => {
    expect(at(settingsOf(), 0.25, 2).position()).toBeCloseTo(0.5);
  });

  it('clamps at the sustain point while the note is held', () => {
    const sustained = settingsOf({
      envelope: { ...settingsOf().envelope, sustain: 1, release: 1 },
    });
    // Point 1 is at 0.5; the run parks there rather than advancing to 1.2.
    expect(at(sustained, 1.2).position()).toBeCloseTo(0.5);
  });

  it('stays at 0 on a loop whose points share one time', () => {
    const flat = settingsOf({
      envelope: {
        points: [
          { time: 0, value: 0 },
          { time: 0, value: 1 },
        ],
        release: 0,
        loop: true,
      },
    });
    // Coincident times pass validation, so the cycle has zero extent. There is nowhere to
    // advance to, and trigger schedules it as a one-shot rather than looping it.
    expect(at(flat, 5).position()).toBe(0);
  });

  it('wraps into the cycle while looping', () => {
    const looping = settingsOf({ envelope: { ...settingsOf().envelope, loop: true } });
    // Cycle is 1.5 long, so 1.75 of wall clock is 0.25 into the second pass.
    expect(at(looping, 1.75).position()).toBeCloseTo(0.25);
  });
});
