import { expect, it } from 'vite-plus/test';
import { getDeclickTiming } from '../declick-timing.js';

it.each([44_100, 48_000, 96_000])('scales fade durations consistently at %s Hz', (rate) => {
  const baseline = getDeclickTiming(rate, 1, 1, 1);
  const strong = getDeclickTiming(rate, 10, 10, 10);
  const decaySeconds = (decay: number) => Math.log(0.01) / Math.log(decay) / rate;

  expect(decaySeconds(baseline.wrapCorrectionDecay)).toBeCloseTo(0.0009106, 7);
  expect(decaySeconds(strong.wrapCorrectionDecay)).toBeCloseTo(
    10 * decaySeconds(baseline.wrapCorrectionDecay),
    7,
  );
  expect(baseline.tailFadeSamples / rate).toBeCloseTo(64 / 48_000, 10);
  expect(strong.tailFadeSamples).toBeCloseTo(10 * baseline.tailFadeSamples);
  expect(getDeclickTiming(rate, 100, 100, 100).tailFadeSamples).toBe(
    100 * baseline.tailFadeSamples,
  );
});

it('can bypass the fades for comparison', () => {
  expect(getDeclickTiming(48_000, 0, 0, 0)).toEqual({
    wrapCorrectionDecay: 0,
    moveCorrectionDecay: 0,
    tailFadeSamples: 0,
  });
});

it('tunes each correction without changing the other two', () => {
  const baseline = getDeclickTiming(48_000, 1, 1, 1);
  expect(getDeclickTiming(48_000, 0, 1, 1)).toEqual({ ...baseline, wrapCorrectionDecay: 0 });
  expect(getDeclickTiming(48_000, 1, 0, 1)).toEqual({ ...baseline, moveCorrectionDecay: 0 });
  expect(getDeclickTiming(48_000, 1, 1, 0)).toEqual({ ...baseline, tailFadeSamples: 0 });
});
