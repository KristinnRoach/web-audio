import { expect, it } from 'vite-plus/test';
import type { EnvelopeConfig } from './envelope-config';
import {
  createDefaultSampleEnvelopeConfig,
  getLiveSampleEnvelopeSustainValue,
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

it('only forwards sustain values that share the active player value domain', () => {
  expect(getLiveSampleEnvelopeSustainValue('amp', config)).toBe(0.25);
  expect(getLiveSampleEnvelopeSustainValue('pitch', config)).toBe(2 ** 0.25);
  expect(getLiveSampleEnvelopeSustainValue('filter', config)).toBeUndefined();
});

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

it('scales amplitude, pitch offset and logarithmic filter sweep without changing the shape', () => {
  const param = { maxValue: 20000 } as AudioParam;
  for (const amount of [0, 0.5, 1, -1]) {
    const amp = resolveSampleEnvelopeTrigger('amp', config.shape, 0.8, param, amount);
    expect(amp.amount).toBe(0.8);
    expect(amp.shape!.points[1].value).toBe(0.25 * amount);
    const pitch = resolveSampleEnvelopeTrigger('pitch', config.shape, 2, param, amount);
    expect(pitch.amount).toBe(2);
    expect(pitch.shape!.points[1].value).toBeCloseTo(2 ** (0.25 * amount));
    const filter = resolveSampleEnvelopeTrigger('filter', config.shape, 200, param, amount);
    expect(filter.shape!.points[1].value).toBeCloseTo(200 * 100 ** (0.25 * amount));
    expect(getLiveSampleEnvelopeSustainValue('amp', { ...config, amount })).toBe(0.25 * amount);
    expect(getLiveSampleEnvelopeSustainValue('pitch', { ...config, amount })).toBeCloseTo(
      2 ** (0.25 * amount),
    );
  }
  expect(config.shape.points[1].value).toBe(0.25);
});
