import { expect, it } from 'vite-plus/test';
import type { EnvelopeConfig } from './envelope-config';
import { getLiveSampleEnvelopeSustainValue } from './sample-envelope-policy';

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
