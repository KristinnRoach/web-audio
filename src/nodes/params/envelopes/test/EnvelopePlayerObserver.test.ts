import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createEnvelopePlayer, type Envelope } from '../Envelope';
import { observeEnvelopePlayer } from '../EnvelopePlayerObserver';
import { createFakeParam } from './fakeParam';

describe('observeEnvelopePlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const envelope = (): Envelope => ({
    points: [
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0.5 },
      { time: 1.5, value: 0 },
    ],
    mode: { type: 'once' },
    release: 2,
  });

  it('reports scheduled points and completion', () => {
    const clock = { currentTime: 0 };
    const shape = envelope();
    const onPoint = vi.fn();
    const onComplete = vi.fn();
    const envPlayer = observeEnvelopePlayer(
      createEnvelopePlayer(clock, createFakeParam(), shape),
      clock,
      shape,
      { onPoint, onComplete },
    );

    envPlayer.trigger(0, { timeScale: 2 });
    vi.advanceTimersByTime(750);

    expect(onPoint.mock.calls.map(([details]) => details.index)).toEqual([0, 1, 2, 3]);
    expect(onPoint.mock.calls.map(([details]) => details.time)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('keeps notifications on its owned shape', () => {
    const clock = { currentTime: 0 };
    const shape = envelope();
    const onPoint = vi.fn();
    const envPlayer = observeEnvelopePlayer(
      createEnvelopePlayer(clock, createFakeParam(), shape),
      clock,
      shape,
      { onPoint },
    );

    envPlayer.trigger(0);
    (shape.points[3] as { value: number }).value = 99;
    clock.currentTime = 0.25;
    envPlayer.release(0.25);
    vi.advanceTimersByTime(500);

    const releasePoint = onPoint.mock.calls.find(([details]) => details.index === 3)?.[0];
    expect(releasePoint?.point.value).toBe(0);
    expect(releasePoint?.time).toBe(0.75);
  });
});
