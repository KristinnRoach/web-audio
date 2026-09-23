import { describe, expect, it } from 'vite-plus/test';
import { envelopePresets } from '../envelope-presets';

describe('envelopePresets', () => {
  it('creates a detached amplitude envelope at the requested duration', () => {
    expect(envelopePresets.amplitude(4)).toEqual({
      mode: { type: 'sustain' },
      sustain: 3,
      points: [
        { time: 0, value: 0, curve: 'exponential' },
        { time: 0.005, value: 1, curve: 'exponential' },
        { time: 1, value: 0.75, curve: 'exponential' },
        { time: 3.6, value: 0.5, curve: 'exponential' },
        { time: 4, value: 0, curve: 'exponential' },
      ],
      release: 3,
    });
  });

  it('rejects invalid durations', () => {
    expect(() => envelopePresets.amplitude(0)).toThrow(RangeError);
  });
});
