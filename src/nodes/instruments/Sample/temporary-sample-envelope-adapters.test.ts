import { expect, it } from 'vite-plus/test';
import type { EnvelopeConfig } from '../../params/envelopes';
import { getLiveSampleEnvelopeSustainValue } from './temporary-sample-envelope-adapters';

const config: EnvelopeConfig = {
  enabled: true,
  timeScale: 1,
  envelope: {
    points: [
      { time: 0, value: 0 },
      { time: 1, value: 0.25 },
      { time: 2, value: 0 },
    ],
    mode: { type: 'sustain', at: 1 },
    release: 1,
  },
};

it('only forwards sustain values that share the active player value domain', () => {
  expect(getLiveSampleEnvelopeSustainValue('amp-env', config)).toBe(0.25);
  expect(getLiveSampleEnvelopeSustainValue('pitch-env', config)).toBe(0.25);
  expect(getLiveSampleEnvelopeSustainValue('filter-env', config)).toBeUndefined();
});
