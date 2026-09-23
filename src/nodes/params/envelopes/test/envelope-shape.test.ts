import { describe, expect, it } from 'vite-plus/test';
import {
  addPoint,
  assertValidEnvelopeShape,
  getDuration,
  interpolateAtTime,
  deletePoint,
  setDuration,
  setSustainPoint,
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
    sustainPoint: 2,
    releasePoint: 2,
    ...overrides,
  };
}

describe('envelope edits', () => {
  it('rejects coincident point times consistently', () => {
    const envelope = envelopeOf();
    expect(addPoint(envelope, 1, 0.5)).toBe(envelope);
    expect(updatePoint(envelope.points, 1, 2)).toBe(envelope.points);

    const invalid = envelopeOf({
      points: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 1, value: 0 },
      ],
    });

    expect(() => assertValidEnvelopeShape(invalid)).toThrow(TypeError);
  });

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
    const next = addPoint(envelopeOf({ mode: { type: 'sustain' }, sustainPoint: 1 }), 0.5, 0.3);
    expect(next.points.map((point) => point.time)).toEqual([0, 0.5, 1, 2, 3]);
    expect(next.mode).toEqual({ type: 'sustain' });
    expect(next.sustainPoint).toBe(2);
    expect(next.releasePoint).toBe(3);
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
    const next = deletePoint(envelopeOf({ mode: { type: 'sustain' }, sustainPoint: 1 }), 1);
    expect(next.points.map((point) => point.time)).toEqual([0, 2, 3]);
    expect(next.mode).toEqual({ type: 'sustain' });
    expect(next.sustainPoint).toBe(1);
    expect(next.releasePoint).toBe(1);
  });

  it('changes the sustain point without changing loop mode', () => {
    const envelope = envelopeOf({ mode: { type: 'loop' }, sustainPoint: 1 });
    const next = setSustainPoint(envelope, 2);

    expect(next.mode).toEqual({ type: 'loop' });
    expect(next.sustainPoint).toBe(2);
  });

  it('refuses to remove anchors or leave fewer than two points', () => {
    const envelope = envelopeOf();
    expect(deletePoint(envelope, 0)).toBe(envelope);
    expect(deletePoint(envelope, 3)).toBe(envelope);
    const pair = envelopeOf({
      points: envelope.points.slice(0, 2),
      releasePoint: 0,
    });
    expect(deletePoint(pair, 1)).toBe(pair);
  });

  it('scales every point about the first one', () => {
    const next = setDuration(envelopeOf().points, 6);
    expect(next.map((point) => point.time)).toEqual([0, 2, 4, 6]);
    expect(getDuration(next)).toBe(6);
    expect(() => setDuration(next, 0)).toThrow(RangeError);
  });
});

describe('envelope timing', () => {
  it('divides the span by the time scale it is handed', () => {
    const { points } = envelopeOf();
    expect(getDuration(points)).toBe(3);
    expect(getDuration(points, { fromIndex: 0, toIndex: 3, timeScale: 2 })).toBe(1.5);
  });

  it("measures the release tail from the release point's time", () => {
    const { points, releasePoint } = envelopeOf();
    expect(getDuration(points, { fromIndex: releasePoint })).toBe(1);
  });

  it('returns zero for an invalid span', () => {
    const { points } = envelopeOf();
    expect(getDuration(points, { fromIndex: 2, toIndex: 1 })).toBe(0);
    expect(getDuration(points, { toIndex: 99 })).toBe(0);
    expect(getDuration(points, { fromIndex: -1, toIndex: 2 })).toBe(0);
  });

  it('rejects an invalid time scale', () => {
    const { points } = envelopeOf();
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => getDuration(points, { timeScale: scale })).toThrow(RangeError);
    }
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
