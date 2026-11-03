import { expect, it } from 'vite-plus/test';
import { getDeclickTiming } from '../declick-timing.js';

it.each([44_100, 48_000, 96_000])('scales fade durations consistently at %s Hz', (rate) => {
  const baseline = getDeclickTiming(rate, 0.5);
  const strong = getDeclickTiming(rate, 0.75);
  const decaySeconds = (decay: number) => Math.log(0.01) / Math.log(decay) / rate;

  expect(decaySeconds(baseline.correctionDecay)).toBeCloseTo(0.0009106, 7);
  expect(decaySeconds(strong.correctionDecay)).toBeCloseTo(
    10 * decaySeconds(baseline.correctionDecay),
    7,
  );
  expect(baseline.tailFadeSamples / rate).toBeCloseTo(64 / 48_000, 10);
  expect(strong.tailFadeSamples).toBeCloseTo(10 * baseline.tailFadeSamples);
  expect(getDeclickTiming(rate, 1).tailFadeSamples).toBe(100 * baseline.tailFadeSamples);
});

it('can bypass the fades for comparison', () => {
  expect(getDeclickTiming(48_000, 0)).toEqual({
    correctionDecay: 0,
    tailFadeSamples: 0,
  });
});
