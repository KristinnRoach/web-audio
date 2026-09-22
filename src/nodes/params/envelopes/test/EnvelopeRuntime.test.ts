import { describe, expect, it } from 'vite-plus/test';
import { createFakeParam } from './fakeParam';
import { EnvelopeRuntime } from '../EnvelopeRuntime';
import type { EnvelopeConfig } from '../envelope-config';

function contextAt(currentTime: number) {
  return { currentTime };
}

function configOf(overrides: Partial<EnvelopeConfig> = {}): EnvelopeConfig {
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
      mode: { type: 'once' },
      release: 2,
    },
    ...overrides,
  };
}

describe('EnvelopeRuntime validation', () => {
  it('requires an explicit mode', () => {
    const config = configOf();
    delete (config.envelope as { mode?: EnvelopeConfig['envelope']['mode'] }).mode;

    expect(() => new EnvelopeRuntime(contextAt(0), config)).toThrow('Invalid envelope settings');
  });

  it('requires a release point', () => {
    const config = configOf() as unknown as {
      enabled: boolean;
      timeScale: number;
      envelope: { points: EnvelopeConfig['envelope']['points'] };
    };
    delete (config.envelope as { release?: number }).release;

    expect(() => new EnvelopeRuntime(contextAt(0), config as EnvelopeConfig)).toThrow(
      'Invalid envelope settings',
    );
  });
});

describe('EnvelopeRuntime live config handover', () => {
  const looping = configOf({
    envelope: {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      release: 1,
      mode: { type: 'loop' },
    },
  });

  it('has no boundary to hand over on unless a loop is running', () => {
    const idle = new EnvelopeRuntime(contextAt(0), looping);
    expect(idle.nextCycleTime()).toBeNull();

    const oneShot = new EnvelopeRuntime(contextAt(0), configOf());
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

    runtime.update({ ...looping, timeScale: 2 });
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
  const looping = configOf({
    envelope: {
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      release: 1,
      mode: { type: 'loop' },
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
    configOf({
      envelope: {
        ...configOf().envelope,
        mode: { type: 'sustain', at: 1 },
        release: 1,
      },
    });

  it('glides to the new value and releases from it', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);

    // Parked on sustain: point 1 lands at 0.5.
    context.currentTime = 1;
    runtime.setSustainValue(0.25);
    expect(param.ramps().at(-1)).toEqual({
      type: 'linear',
      value: 0.25,
      time: 1.02,
    });

    // The tail has to hand off from the edited value, not the one captured at trigger.
    // The glide's own pin sits at this same instant, so it is the last write that counts.
    runtime.release(1);
    const pins = param.ramps().filter((event) => event.type === 'set' && event.time === 1);
    expect(pins.at(-1)?.value).toBe(0.25);
  });

  it('keeps config updates separate from the active player', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);

    context.currentTime = 1;
    const before = param.events.length;
    const edited = sustaining();
    const config = {
      ...edited,
      envelope: {
        ...edited.envelope,
        points: edited.envelope.points.map((point, index) =>
          index === 1 ? { ...point, value: 0.25 } : point,
        ),
      },
    };
    runtime.update(config);

    expect(runtime.config.envelope.points[1].value).toBe(0.25);
    expect(param.events.length).toBe(before);
  });
});

describe('EnvelopeRuntime.trigger validation', () => {
  it('rejects a caller-supplied shape with an out-of-range sustain', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), configOf());
    const bad = {
      ...configOf().envelope,
      mode: { type: 'sustain' as const, at: 9 },
    };

    expect(() => runtime.trigger(createFakeParam(), 0, { envelope: bad })).toThrow(
      'Invalid envelope',
    );
  });

  it('still accepts a valid caller-supplied shape', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), configOf());
    const mapped = configOf().envelope;

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
  const badShape = () => ({
    ...configOf().envelope,
    mode: { type: 'sustain' as const, at: 9 },
  });

  it('keeps the active player running', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), configOf());
    runtime.trigger(createFakeParam(), 0);
    const before = runtime.currentPoint();

    expect(() => runtime.trigger(createFakeParam(), 0, { envelope: badShape() })).toThrow(
      'Invalid envelope',
    );

    expect(runtime.currentPoint()).toBe(before);
  });

  it('keeps a released run released', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), configOf());
    runtime.trigger(createFakeParam(), 0);
    runtime.release(0);

    expect(() => runtime.trigger(createFakeParam(), 0, { envelope: badShape() })).toThrow(
      'Invalid envelope',
    );

    // Still released, so a second release stays the no-op it was.
    runtime.release(0);
    expect(runtime.currentPoint()).toBeNull();
  });
});
