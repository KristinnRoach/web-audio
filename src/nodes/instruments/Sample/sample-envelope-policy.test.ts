import { expect, it } from 'vite-plus/test';
import type { EnvelopeConfig } from './envelope-config';
import {
  createDefaultSampleEnvelopeConfig,
  resolveSampleEnvelopeForProcessor,
  SAMPLE_ENVELOPE_IDS,
} from './sample-envelope-policy';
import { cloneEnvelopeConfig, assertValidEnvelopeConfig } from './envelope-config';

const config: EnvelopeConfig = {
  enabled: true,
  timeScale: 1,
  shape: {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 0.25 },
      { time: 2, value: 0 },
    ],
    mode: { type: 'sustain' },
    sustainPoint: 1,
    releasePoint: 1,
  },
};

it('accepts configs with valid defaults and without depth, rejects non-finite depth', () => {
  for (const id of SAMPLE_ENVELOPE_IDS) {
    expect(() => assertValidEnvelopeConfig(createDefaultSampleEnvelopeConfig(id, 1))).not.toThrow();
  }
  expect(() => assertValidEnvelopeConfig(config)).not.toThrow();
  for (const depth of [NaN, Infinity, -Infinity]) {
    expect(() => assertValidEnvelopeConfig({ ...config, depth })).toThrow(
      'Invalid envelope settings',
    );
  }
});

const pitchBase = (depth: number) =>
  resolveSampleEnvelopeForProcessor('pitch', { ...config, depth }).base;

it('scales amplitude by depth and pitch and filter detune in cents, without changing the shape', () => {
  for (const depth of [0, 0.5, 1, -1]) {
    const amp = resolveSampleEnvelopeForProcessor('amp', { ...config, depth });
    expect(amp.depth).toBe(depth);
    expect(amp.base).toBe(1 - depth);
    expect(pitchBase(depth)).toBe(0);
    const pitch = resolveSampleEnvelopeForProcessor('pitch', { ...config, depth });
    expect(pitch.depth).toBe(1200 * depth);
    expect(pitch.shape.points.every((point) => point.curve === 'linear')).toBe(true);
    expect(resolveSampleEnvelopeForProcessor('filter', { ...config, depth }).depth).toBe(
      12000 * depth,
    );
  }
  expect(config.shape.points[1].value).toBe(0.25);
  expect(config.shape.points[1].curve).toBeUndefined();
});

it('clones signed depth without adding legacy fields', () => {
  const snapshot = cloneEnvelopeConfig({ ...config, depth: -0.5 });
  expect(snapshot.depth).toBe(-0.5);
  expect(snapshot).not.toHaveProperty('amount');
  expect(resolveSampleEnvelopeForProcessor('pitch', snapshot).depth).toBe(-600);
});

it('validates loopSync', () => {
  expect(() => assertValidEnvelopeConfig({ ...config, loopSync: true })).not.toThrow();
  expect(() =>
    assertValidEnvelopeConfig({
      ...config,
      loopSync: 'yes' as unknown as boolean,
    }),
  ).toThrow('Invalid envelope settings');
});

it('maps bipolar shapes piecewise onto the range, keeping 0 unmodulated', () => {
  const pitch = resolveSampleEnvelopeForProcessor('pitch', {
    ...config,
    depth: 0.5,
    range: [-1200, 2400],
  });
  expect(pitch.base).toBe(0);
  expect(pitch.depth).toBe(1200); // shape 1 -> half of +2400 cents
  expect(pitch.negativeDepth).toBe(600); // shape -1 -> half of -1200 cents
});

it('maps unipolar shapes linearly onto the range, mixing from rest by depth', () => {
  const filter = resolveSampleEnvelopeForProcessor('filter', { ...config, range: [-1200, 2400] });
  expect(filter.base).toBe(-1200);
  expect(filter.depth).toBe(3600);
  expect(filter.negativeDepth).toBeUndefined();
  const amp = resolveSampleEnvelopeForProcessor('amp', { ...config, depth: 0.5, range: [0, 2] });
  expect(amp.base).toBe(0.5); // shape 0 -> halfway from rest 1 to 0
  expect(amp.depth).toBe(1); // shape 1 -> halfway from rest 1 to 2
});

it('validates and clones range', () => {
  expect(() => assertValidEnvelopeConfig({ ...config, range: [-1, 2] })).not.toThrow();
  for (const range of [[1, 0], [0, NaN], [0], 'wide']) {
    expect(() =>
      assertValidEnvelopeConfig({ ...config, range: range as unknown as [number, number] }),
    ).toThrow('Invalid envelope settings');
  }
  const range = [-1, 2] as const;
  const snapshot = cloneEnvelopeConfig({ ...config, range });
  expect(snapshot.range).toEqual(range);
  expect(snapshot.range).not.toBe(range);
  expect(cloneEnvelopeConfig(config)).not.toHaveProperty('range');
});
