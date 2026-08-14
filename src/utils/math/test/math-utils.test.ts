import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { clamp, mapToRange } from '../math-utils';

describe('clamp', () => {
  test('should properly clamp values within range', () => {
    expect(clamp(5, 0, 10)).toBe(5); // within range
    expect(clamp(-1, 0, 10)).toBe(0); // below min
    expect(clamp(11, 0, 10)).toBe(10); // above max
  });

  test('should handle audio-typical ranges like -1 to 1', () => {
    expect(clamp(0.5, -1, 1)).toBe(0.5); // normal audio signal
    expect(clamp(1.5, -1, 1)).toBe(1); // clipping prevention
    expect(clamp(-2.5, -1, 1)).toBe(-1); // under-range protection
  });
});

describe('mapToRange', () => {
  test('should correctly map values within normal ranges', () => {
    // Map normalized range (0-1) to audio range (-1 to 1)
    expect(mapToRange(0.5, 0, 1, -1, 1)).toBe(0);
    expect(mapToRange(0, 0, 1, -1, 1)).toBe(-1);
    expect(mapToRange(1, 0, 1, -1, 1)).toBe(1);
  });

  test('should handle frequency-like exponential ranges', () => {
    // Map 0-100 to typical filter frequency range 20-20000 (linear mapping)
    const result = mapToRange(50, 0, 100, 20, 20000);
    expect(result).toBeGreaterThan(20);
    expect(result).toBeLessThan(20000);
    // At 50% of input range, should map to 50% of output range
    expect(result).toBeCloseTo(10010); // 20 + (20000-20)*0.5
  });

  test('should clamp out-of-range inputs', () => {
    // Test upper bound clamping
    const upperResult = mapToRange(2, 0, 1, -1, 1);
    expect(upperResult).toBe(1);

    // Test lower bound clamping
    const lowerResult = mapToRange(-1, 0, 1, -1, 1);
    expect(lowerResult).toBe(-1);

    // Test clamping in both ranges simultaneously
    const result = mapToRange(150, 0, 100, 20, 20000);
    expect(result).toBe(20000);
  });

  test('should handle edge cases correctly', () => {
    // Equal input range (mapping from a point)
    expect(mapToRange(5, 5, 5, 0, 1)).toBe(0.5);

    // Equal output range (mapping to a point)
    expect(mapToRange(0.5, 0, 1, 42, 42)).toBe(42);

    // Inverted ranges (high to low)
    expect(mapToRange(0.75, 0, 1, 1, -1)).toBe(-0.5);
  });
});
