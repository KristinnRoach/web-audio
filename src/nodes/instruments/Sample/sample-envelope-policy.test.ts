import { expect, it } from 'vite-plus/test';
import type { EnvelopeConfig } from './envelope-config';
import {
  createDefaultSampleEnvelopeConfig,
  getSampleEnvelopeRestValue,
  resolveSampleEnvelopeTrigger,
  SAMPLE_ENVELOPE_IDS,
} from './sample-envelope-policy';
import { assertValidEnvelopeConfig } from './envelope-config';

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

it('defaults amount to one and accepts older configs without it', () => {
  for (const id of SAMPLE_ENVELOPE_IDS) {
    expect(createDefaultSampleEnvelopeConfig(id, 1).amount).toBe(1);
  }
  expect(() => assertValidEnvelopeConfig(config)).not.toThrow();
  for (const amount of [NaN, Infinity, -Infinity]) {
    expect(() => assertValidEnvelopeConfig({ ...config, amount })).toThrow(
      'Invalid envelope settings',
    );
  }
});

it('scales amplitude by amount and pitch and filter detune in cents, without changing the shape', () => {
  for (const amount of [0, 0.5, 1, -1]) {
    const amp = resolveSampleEnvelopeTrigger('amp', { amount });
    expect(amp.amount).toBe(amount);
    const pitch = resolveSampleEnvelopeTrigger('pitch', { amount });
    expect(pitch).toEqual({ amount: 1200 * amount, curve: 'linear' });
    const filter = resolveSampleEnvelopeTrigger('filter', { amount });
    expect(filter).toEqual({ amount: 12000 * amount, curve: 'linear' });
  }
  expect(config.shape.points[1].value).toBe(0.25);
});

it('leaves velocity scaling to the processor while envelopes are disabled', () => {
  expect(getSampleEnvelopeRestValue('amp')).toBe(1);
  expect(getSampleEnvelopeRestValue('pitch')).toBe(0);
  expect(getSampleEnvelopeRestValue('filter')).toBe(0);
});
