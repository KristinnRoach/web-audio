import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createFakeParam } from './fakeParam';
import { EnvelopeRuntime } from './EnvelopeRuntime';
import type { EnvelopeSettings } from './Envelope';

function contextAt(currentTime: number) {
  return { currentTime, sampleRate: 44100 } as AudioContext & { currentTime: number };
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

describe('EnvelopeRuntime callbacks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not create callback timers when it has no callbacks', () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    runtime.trigger(createFakeParam(), 0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports scheduled points and completion', () => {
    const onPoint = vi.fn();
    const onComplete = vi.fn();
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf(), { onPoint, onComplete });

    runtime.trigger(createFakeParam(), 0, { timeScaleMultiplier: 2 });
    vi.advanceTimersByTime(750);

    expect(onPoint.mock.calls.map(([details]) => details.index)).toEqual([0, 1, 2, 3]);
    expect(onPoint.mock.calls.map(([details]) => details.time)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('keeps callbacks on the active shape after settings change', () => {
    const context = contextAt(0);
    const onPoint = vi.fn();
    const onComplete = vi.fn();
    const runtime = new EnvelopeRuntime(context, settingsOf(), { onPoint, onComplete });

    runtime.trigger(createFakeParam(), 0);
    runtime.applySettings(
      settingsOf({
        timeScale: 10,
        envelope: {
          points: [
            { time: 0, value: 0 },
            { time: 1, value: 1 },
            { time: 2, value: 0 },
          ],
          release: 1,
        },
      }),
    );

    context.currentTime = 0.25;
    runtime.release(0.25);
    vi.advanceTimersByTime(500);

    const releasePoint = onPoint.mock.calls.find(([details]) => details.index === 3)?.[0];
    expect(releasePoint?.point.value).toBe(0);
    expect(releasePoint?.time).toBe(0.75);
    expect(onComplete).toHaveBeenCalledOnce();
  });

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

  it('picks the edit up from applySettings while the note is held', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);

    context.currentTime = 1;
    const edited = sustaining();
    runtime.applySettings({
      ...edited,
      envelope: {
        ...edited.envelope,
        points: edited.envelope.points.map((point, index) =>
          index === 1 ? { ...point, value: 0.25 } : point,
        ),
      },
    });

    expect(param.ramps().at(-1)).toEqual({ type: 'linear', value: 0.25, time: 1.02 });
  });

  it('leaves the queued shape alone when the run has not reached sustain', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);
    const queued = param.ramps().length;

    // Point 1 lands at 0.5, so the attack is still in flight here. Cancelling to write
    // the new value would take the attack ramp with it.
    context.currentTime = 0.2;
    const edited = sustaining();
    runtime.applySettings({
      ...edited,
      envelope: {
        ...edited.envelope,
        points: edited.envelope.points.map((point, index) =>
          index === 1 ? { ...point, value: 0.25 } : point,
        ),
      },
    });

    expect(param.events.length).toBe(queued + 1); // the trigger's own cancel, nothing more
  });

  it('writes nothing when the sustain value is unchanged', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    runtime.trigger(param, 0);

    context.currentTime = 1;
    const before = param.events.length;
    runtime.applySettings(sustaining());

    expect(param.events.length).toBe(before);
  });

  it('leaves a run playing its own mapped shape alone', () => {
    const context = contextAt(0);
    const param = createFakeParam();
    const runtime = new EnvelopeRuntime(context, sustaining());
    // Stand-in for the sampler's filter envelope: the run plays Hz, settings are normalized.
    const mapped = sustaining().envelope;
    runtime.trigger(param, 0, {
      envelope: { ...mapped, points: mapped.points.map((p) => ({ ...p, value: p.value * 8000 })) },
    });

    context.currentTime = 1;
    const before = param.ramps().length;
    runtime.applySettings(sustaining());

    expect(param.ramps().length).toBe(before);
  });
});
