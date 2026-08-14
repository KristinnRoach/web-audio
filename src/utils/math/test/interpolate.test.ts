import { describe, test, expect, vi } from 'vitest';
import {
  interpolate,
  interpolateLinearToLog,
  interpolateLinearToExp,
} from '../interpolate';

describe('interpolate', () => {
  test('power curves should produce non-linear progression', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 },
    };

    const linear = interpolate(0.5, { ...options, curve: 'linear' });
    const power2 = interpolate(0.5, { ...options, curve: 'power2' });
    const power4 = interpolate(0.5, { ...options, curve: 'power4' });

    expect(linear).toBe(50); // exactly halfway
    expect(power2).toBeGreaterThan(linear); // power curves should give more resolution at high end
    expect(power4).toBeGreaterThan(power2); // higher power = more extreme curve
  });

  test('exponential curve should handle edge cases correctly', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 },
      curve: 'expo' as const,
    };

    expect(interpolate(0, options)).toBe(0); // expo curve starts at 0
    expect(interpolate(1, options)).toBe(100); // ends at max
    expect(interpolate(0.5, options)).toBeLessThan(50); // exponential is front-loaded
  });

  test('custom numeric curve should work as power function', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 },
    };

    const customPower = interpolate(0.5, { ...options, curve: 2.5 });
    const power2 = interpolate(0.5, { ...options, curve: 'power2' });

    expect(customPower).toBeGreaterThan(power2); // 2.5 power should be between power2 and power3
    expect(customPower).toBeLessThan(
      interpolate(0.5, { ...options, curve: 'power3' })
    );
  });
});

describe('interpolateLinearToLog', () => {
  test('should blend between linear and logarithmic scaling', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 1000 }, // 3 decades for clear log effect
    };

    const linear = interpolateLinearToLog(0.5, { ...options, blend: 0 });
    const logarithmic = interpolateLinearToLog(0.5, { ...options, blend: 1 });
    const blended = interpolateLinearToLog(0.5, { ...options, blend: 0.5 });

    expect(linear).toBeCloseTo(500.5, 0); // linear midpoint
    expect(logarithmic).toBeCloseTo(31.6, 0); // log midpoint ≈ sqrt(1000)
    expect(blended).toBeCloseTo((linear + logarithmic) / 2, 0); // average of both
  });

  test('different log bases should work correctly', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 1000 },
      blend: 1,
    };

    const dB = interpolateLinearToLog(0.5, { ...options, logBase: 'dB' });
    const hz = interpolateLinearToLog(0.5, { ...options, logBase: 'Hz' });
    const natural = interpolateLinearToLog(0.5, {
      ...options,
      logBase: 'natural',
    });

    // All should be valid logarithmic interpolations (closer to geometric mean)
    expect(dB).toBeGreaterThan(1);
    expect(dB).toBeLessThan(1000);
    expect(dB).toBeLessThan(500); // should be less than linear midpoint

    expect(hz).toBeGreaterThan(1);
    expect(hz).toBeLessThan(1000);

    expect(natural).toBeGreaterThan(1);
    expect(natural).toBeLessThan(1000);
  });

  test('curve adjustment should modify the input scaling', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 100 },
      blend: 1,
    };

    const linear = interpolateLinearToLog(0.5, { ...options, curve: 'linear' });
    const steep = interpolateLinearToLog(0.5, { ...options, curve: 'steep' });

    expect(steep).toBeGreaterThan(linear); // steep curve pushes values higher
  });
});

describe('interpolateLinearToExp', () => {
  test('exponential scaling should accelerate growth', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 100 },
      blend: 1,
    };

    const linear = interpolateLinearToExp(0.5, { ...options, blend: 0 });
    const exponential = interpolateLinearToExp(0.5, { ...options, blend: 1 });

    expect(linear).toBeCloseTo(50.5, 0); // linear midpoint
    expect(exponential).toBeCloseTo(10, 0); // exp midpoint = sqrt(100) = 10
    expect(exponential).toBeLessThan(linear); // exponential grows slowly at start
  });

  test('should handle audio-typical frequency ranges correctly', () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 20, max: 20000 }, // typical audio frequency range
      blend: 1,
      logBase: 'Hz' as const,
    };

    const lowFreq = interpolateLinearToExp(0.1, options);
    const midFreq = interpolateLinearToExp(0.5, options);
    const highFreq = interpolateLinearToExp(0.9, options);

    expect(lowFreq).toBeLessThan(100); // should stay in low range
    expect(midFreq).toBeCloseTo(632, 0); // geometric mean of 20 and 20000
    expect(highFreq).toBeLessThan(20000); // shouldn't quite reach maximum
    expect(highFreq).toBeGreaterThan(midFreq * 2); // should show exponential growth
  });

  test('should warn for invalid output ranges', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    interpolateLinearToExp(0.5, {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 }, // min = 0 is invalid for exponential
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      'interpolateLinearToExp: Output min must be > 0 for exponential interpolation'
    );

    consoleSpy.mockRestore();
  });
});
