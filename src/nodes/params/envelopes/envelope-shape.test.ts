import { describe, expect, it } from 'vite-plus/test';
import {
  addPoint,
  baseDuration,
  deletePoint,
  releaseDuration,
  releaseStartTime,
  scaledDuration,
  setDuration,
  updatePoint,
} from './envelope-shape';
import type { Envelope, EnvelopeSettings } from './Envelope';

function envelopeOf(overrides: Partial<Envelope> = {}): Envelope {
  return {
    points: [
      { time: 0, value: 0, curve: 'exponential' },
      { time: 1, value: 1, curve: 'exponential' },
      { time: 2, value: 0.5, curve: 'exponential' },
      { time: 3, value: 0, curve: 'exponential' },
    ],
    release: 2,
    ...overrides,
  };
}

const settingsOf = (
  envelope: Envelope,
  overrides: Partial<EnvelopeSettings> = {},
): EnvelopeSettings => ({ enabled: true, timeScale: 1, envelope, ...overrides });

describe('envelope edits', () => {
  it('never mutates the envelope it was given', () => {
    const envelope = envelopeOf();
    const before = JSON.stringify(envelope);

    addPoint(envelope, 1.5, 0.8);
    updatePoint(envelope, 1, 1.2);
    deletePoint(envelope, 1);
    setDuration(envelope, 6);

    expect(JSON.stringify(envelope)).toBe(before);
  });

  it('inserts in time order and carries markers along', () => {
    const next = addPoint(envelopeOf({ sustain: 1 }), 0.5, 0.3);
    expect(next.points.map((point) => point.time)).toEqual([0, 0.5, 1, 2, 3]);
    expect(next.sustain).toBe(2);
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
    const envelope = envelopeOf();
    expect(updatePoint(envelope, 2, 0.5)).toBe(envelope);
    expect(updatePoint(envelope, 1, 2.5)).toBe(envelope);
    expect(updatePoint(envelope, 1, Number.NaN)).toBe(envelope);
    expect(updatePoint(envelope, 1, Number.NEGATIVE_INFINITY)).toBe(envelope);
    expect(updatePoint(envelope, 1, 1.5).points[1].time).toBe(1.5);
  });

  it('removes interior points and adjusts markers', () => {
    const next = deletePoint(envelopeOf({ sustain: 1 }), 1);
    expect(next.points.map((point) => point.time)).toEqual([0, 2, 3]);
    expect(next.sustain).toBeUndefined();
    expect(next.release).toBe(1);
  });

  it('refuses to remove anchors or leave fewer than two points', () => {
    const envelope = envelopeOf();
    expect(deletePoint(envelope, 0)).toBe(envelope);
    expect(deletePoint(envelope, 3)).toBe(envelope);
    const pair = envelopeOf({ points: envelope.points.slice(0, 2), release: 0 });
    expect(deletePoint(pair, 1)).toBe(pair);
  });

  it('scales every point about the first one', () => {
    const next = setDuration(envelopeOf(), 6);
    expect(next.points.map((point) => point.time)).toEqual([0, 2, 4, 6]);
    expect(baseDuration(next)).toBe(6);
    expect(() => setDuration(next, 0)).toThrow(RangeError);
  });
});

describe('envelope timing', () => {
  it('combines the stored time scale with a runtime multiplier', () => {
    const envelope = envelopeOf();
    expect(scaledDuration(settingsOf(envelope), 0, 3)).toBe(3);
    expect(scaledDuration(settingsOf(envelope, { timeScale: 2 }), 0, 3)).toBe(1.5);
    expect(scaledDuration(settingsOf(envelope), 0, 3, 2)).toBe(1.5);
  });

  it('splits the envelope at its release point', () => {
    const settings = settingsOf(envelopeOf());
    expect(releaseStartTime(settings)).toBe(2);
    expect(releaseDuration(settings)).toBe(1);
    expect(releaseStartTime(settings) + releaseDuration(settings)).toBe(
      baseDuration(settings.envelope),
    );
  });

  it('returns zero for an invalid span', () => {
    const settings = settingsOf(envelopeOf());
    expect(scaledDuration(settings, 2, 1)).toBe(0);
    expect(scaledDuration(settings, 0, 99)).toBe(0);
    expect(scaledDuration(settings, -1, 2)).toBe(0);
  });
});
