import { describe, it, expect } from 'vite-plus/test';
import { clampHz, durationToTimeConstant, maxSafeHz, FALLBACK_MAX_HZ, MIN_HZ } from '../audioparam';

describe('maxSafeHz', () => {
  it('leaves a 1 kHz guard band below Nyquist', () => {
    expect(maxSafeHz(48000)).toBe(23000);
    expect(maxSafeHz(44100)).toBe(21050);
  });

  it('falls back without a usable sample rate', () => {
    expect(maxSafeHz()).toBe(FALLBACK_MAX_HZ);
    expect(maxSafeHz(0)).toBe(FALLBACK_MAX_HZ);
  });
});

describe('clampHz', () => {
  it('clamps to the safe range', () => {
    expect(clampHz(500, 48000)).toBe(500);
    expect(clampHz(0, 48000)).toBe(MIN_HZ);
    expect(clampHz(99999, 48000)).toBe(23000);
    expect(clampHz(99999)).toBe(FALLBACK_MAX_HZ);
  });
});

describe('durationToTimeConstant', () => {
  it('divides a positive glide by 3 so it settles on time', () => {
    expect(durationToTimeConstant(0.9, 0.1)).toBeCloseTo(0.3);
  });

  it('falls back for input setTargetAtTime would reject', () => {
    expect(durationToTimeConstant(undefined, 0.1)).toBe(0.1);
    expect(durationToTimeConstant(0, 0.1)).toBe(0.1);
    expect(durationToTimeConstant(-0.5, 0.1)).toBe(0.1); // negative tau throws RangeError
    expect(durationToTimeConstant(Infinity, 0.1)).toBe(0.1);
    expect(durationToTimeConstant(NaN, 0.1)).toBe(0.1);
  });
});
