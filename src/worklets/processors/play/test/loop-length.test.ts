import { describe, expect, it } from 'vite-plus/test';
import {
  driftLoopEnd,
  driftRollInterval,
  glideToward,
  isInQuantizationRange,
  loopDriftSamples,
  longestPeriodWithin,
  quantizeLoopLength,
} from '../engine/loop-length.js';

describe('loop length stages', () => {
  it('quantizes to the nearest period only inside the range', () => {
    const periods = [100, 200, 400];
    expect(quantizeLoopLength(140, periods)).toBe(100);
    expect(quantizeLoopLength(160, periods)).toBe(200);
    expect(quantizeLoopLength(401, periods)).toBe(401);
    expect(quantizeLoopLength(140, undefined)).toBe(140);
    expect(isInQuantizationRange(0.5, periods)).toBe(false);
  });

  it('finds the longest period that fits', () => {
    const periods = [100, 200, 400];
    expect(longestPeriodWithin(399, periods)).toBe(200);
    expect(longestPeriodWithin(400, periods)).toBe(400);
    expect(longestPeriodWithin(99, periods)).toBeUndefined();
    expect(longestPeriodWithin(100, undefined)).toBeUndefined();
  });

  it('glides and lands exactly on the target', () => {
    expect(glideToward(0, 10, 0.5, 1e-6)).toBe(5);
    expect(glideToward(10 - 1e-7, 10, 0.5, 1e-6)).toBe(10);
    expect(glideToward(0, 10, 1, 1e-6)).toBe(10);
  });

  it('rolls audio-rate drift less often', () => {
    expect(driftRollInterval(100, 1000)).toBe(10);
    expect(driftRollInterval(2000, 1000)).toBe(1);
  });

  it('scales drift from 10% to 100% of the amount with loop length', () => {
    expect(loopDriftSamples(1, 0.5, 1000)).toBe(50);
    expect(loopDriftSamples(0, 0.5, 8192)).toBe(-4096);
    expect(loopDriftSamples(0.5, 0.5, 8192)).toBe(0);
  });

  it('keeps a drifted end above 10% of the loop and below the ceiling', () => {
    expect(driftLoopEnd(0, 1000, 1000, -5000, 2000)).toBe(100);
    expect(driftLoopEnd(0, 1000, 1000, 5000, 2000)).toBe(2000);
    // A keytracked end past the audio stays the ceiling.
    expect(driftLoopEnd(0, 3000, 3000, 500, 2000)).toBe(3000);
  });
});
