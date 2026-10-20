import { expect, it } from 'vite-plus/test';
import type { EnvelopeConfig } from './envelope-config';
import {
  createDefaultSampleEnvelopeConfig,
  getSampleEnvelopeRestValue,
  resolveSampleEnvelopeTrigger,
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

it('scales amplitude by depth and pitch and filter detune in cents, without changing the shape', () => {
  for (const depth of [0, 0.5, 1, -1]) {
    const amp = resolveSampleEnvelopeTrigger('amp', { depth });
    expect(amp.depth).toBe(depth);
    const pitch = resolveSampleEnvelopeTrigger('pitch', { depth });
    expect(pitch).toEqual({ depth: 1200 * depth, curve: 'linear' });
    const filter = resolveSampleEnvelopeTrigger('filter', { depth });
    expect(filter).toEqual({ depth: 12000 * depth, curve: 'linear' });
  }
  expect(config.shape.points[1].value).toBe(0.25);
});

it('leaves velocity scaling to the processor while envelopes are disabled', () => {
  expect(getSampleEnvelopeRestValue('amp')).toBe(1);
  expect(getSampleEnvelopeRestValue('pitch')).toBe(0);
  expect(getSampleEnvelopeRestValue('filter')).toBe(0);
});

it('clones signed depth without adding legacy fields', () => {
  const snapshot = cloneEnvelopeConfig({ ...config, depth: -0.5 });
  expect(snapshot.depth).toBe(-0.5);
  expect(snapshot).not.toHaveProperty('amount');
  expect(resolveSampleEnvelopeTrigger('pitch', { depth: -0.5 })).toEqual({
    depth: -600,
    curve: 'linear',
  });
});
