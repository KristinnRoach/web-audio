import { describe, expect, it } from 'vite-plus/test';
import {
  addPoint,
  baseDuration,
  interpolateAtTime,
  deletePoint,
  releaseDuration,
  releaseStartTime,
  scaledDuration,
  setDuration,
  updatePoint,
} from '../envelope-shape';
import type { EnvelopeShape } from '../envelope-shape';

function envelopeOf(overrides: Partial<EnvelopeShape> = {}): EnvelopeShape {
  return {
    points: [
      { time: 0, value: 0, curve: 'exponential' },
      { time: 1, value: 1, curve: 'exponential' },
      { time: 2, value: 0.5, curve: 'exponential' },
      { time: 3, value: 0, curve: 'exponential' },
    ],
    mode: { type: 'once' },
    release: 2,
    ...overrides,
  };
}

describe('envelope edits', () => {
  it('never mutates the envelope it was given', () => {
    const envelope = envelopeOf();
    const before = JSON.stringify(envelope);

    addPoint(envelope, 1.5, 0.8);
    updatePoint(envelope.points, 1, 1.2);
    deletePoint(envelope, 1);
    setDuration(envelope.points, 6);

    expect(JSON.stringify(envelope)).toBe(before);
  });

  it('inserts in time order and carries markers along', () => {
    const next = addPoint(envelopeOf({ mode: { type: 'sustain', at: 1 } }), 0.5, 0.3);
    expect(next.points.map((point) => point.time)).toEqual([0, 0.5, 1, 2, 3]);
    expect(next.mode).toEqual({ type: 'sustain', at: 2 });
    expect(next.release).toBe(3);
  });

  it('refuses points outside the anchors', () => {
    const envelope = envelopeOf();
    expect(addPoint(envelope, -1, 0.5)).toBe(envelope);
    expect(addPoint(envelope, 4, 0.5)).toBe(envelope);
    expect(addPoint(envelope, Number.NaN, 0.5)).toBe(envelope);
    expect(addPoint(envelope, Number.POSITIVE_INFINITY, 0.5)).toBe(envelope);
  });

  it('refuses a move across either neighbour', () => {
    const { points } = envelopeOf();
    // Rejected edits hand the same array back, so a caller can compare by identity.
    expect(updatePoint(points, 2, 0.5)).toBe(points);
    expect(updatePoint(points, 1, 2.5)).toBe(points);
    expect(updatePoint(points, 1, Number.NaN)).toBe(points);
    expect(updatePoint(points, 1, Number.NEGATIVE_INFINITY)).toBe(points);
    expect(updatePoint(points, 1, 1.5)[1].time).toBe(1.5);
  });

  it('removes interior points and adjusts markers', () => {
    const next = deletePoint(envelopeOf({ mode: { type: 'sustain', at: 1 } }), 1);
    expect(next.points.map((point) => point.time)).toEqual([0, 2, 3]);
    expect(next.mode).toEqual({ type: 'once' });
    expect(next.release).toBe(1);
  });

  it('refuses to remove anchors or leave fewer than two points', () => {
    const envelope = envelopeOf();
    expect(deletePoint(envelope, 0)).toBe(envelope);
    expect(deletePoint(envelope, 3)).toBe(envelope);
    const pair = envelopeOf({
      points: envelope.points.slice(0, 2),
      release: 0,
    });
    expect(deletePoint(pair, 1)).toBe(pair);
  });

  it('scales every point about the first one', () => {
    const next = setDuration(envelopeOf().points, 6);
    expect(next.map((point) => point.time)).toEqual([0, 2, 4, 6]);
    expect(baseDuration(next)).toBe(6);
    expect(() => setDuration(next, 0)).toThrow(RangeError);
  });
});

describe('envelope timing', () => {
  it('divides the span by the time scale it is handed', () => {
    const { points } = envelopeOf();
    expect(scaledDuration(points, 0, 3)).toBe(3);
    expect(scaledDuration(points, 0, 3, 2)).toBe(1.5);
    // Composing a stored scale with a per-run multiplier is the caller's job;
    // SampleVoice.#timeScale and InstrumentBus.#triggerLpfEnvelope do it.
    expect(scaledDuration(points, 0, 3, 1 * 2)).toBe(1.5);
  });

  it('splits the envelope at its release point', () => {
    const { points, release } = envelopeOf();
    expect(releaseStartTime(points, release)).toBe(2);
    expect(releaseDuration(points, release)).toBe(1);
    expect(releaseStartTime(points, release) + releaseDuration(points, release)).toBe(
      baseDuration(points),
    );
  });

  it('returns zero for an invalid span', () => {
    const { points } = envelopeOf();
    expect(scaledDuration(points, 2, 1)).toBe(0);
    expect(scaledDuration(points, 0, 99)).toBe(0);
    expect(scaledDuration(points, -1, 2)).toBe(0);
  });
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
