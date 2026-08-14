import { describe, it, expect } from 'vitest';

describe('Amplitude compensation edge cases', () => {
  
  // Simulate the amplitude compensation logic
  function calculateMakeupGain(rmsAmplitude, targetAmplitude = 0.3) {
    let makeupGain = 1.0;
    if (rmsAmplitude < targetAmplitude) {
      // Use a minimum floor to avoid division by very small numbers
      const safeRms = Math.max(rmsAmplitude, 1e-3);
      makeupGain = targetAmplitude / safeRms;
      // Limit gain to reasonable range
      makeupGain = Math.min(2.0, makeupGain);
    }
    return makeupGain;
  }

  describe('calculateMakeupGain', () => {
    it('should return 1.0 for RMS at or above target', () => {
      expect(calculateMakeupGain(0.3)).toBe(1.0);
      expect(calculateMakeupGain(0.5)).toBe(1.0);
      expect(calculateMakeupGain(1.0)).toBe(1.0);
    });

    it('should calculate correct gain for normal RMS values', () => {
      // RMS = 0.15, target = 0.3, gain = 2.0
      expect(calculateMakeupGain(0.15)).toBe(2.0);
      
      // RMS = 0.2, target = 0.3, gain = 1.5
      expect(calculateMakeupGain(0.2)).toBeCloseTo(1.5, 5);
    });

    it('should handle very small RMS values without producing huge gains', () => {
      // Without the floor, 0.3 / 0.0001 = 3000 -> clamped to 2.0
      // With floor of 0.001, 0.3 / 0.001 = 300 -> clamped to 2.0
      expect(calculateMakeupGain(0.0001)).toBe(2.0);
      expect(calculateMakeupGain(0.00001)).toBe(2.0);
      expect(calculateMakeupGain(1e-10)).toBe(2.0);
    });

    it('should handle zero RMS gracefully', () => {
      // With floor, 0.3 / 0.001 = 300 -> clamped to 2.0
      expect(calculateMakeupGain(0)).toBe(2.0);
    });

    it('should handle negative RMS (shouldn\'t happen but defensive)', () => {
      // Floor should handle this: max(-0.1, 0.001) = 0.001
      expect(calculateMakeupGain(-0.1)).toBe(2.0);
    });

    it('should respect the maximum gain limit', () => {
      // All very small values should result in 2.0 max gain
      const smallValues = [0.001, 0.0001, 0.00001, 0, -1];
      smallValues.forEach(value => {
        expect(calculateMakeupGain(value)).toBeLessThanOrEqual(2.0);
      });
    });

    it('should produce stable gain values for near-zero RMS', () => {
      // Test that we don't get wildly different gains for tiny differences
      const gain1 = calculateMakeupGain(0.0001);
      const gain2 = calculateMakeupGain(0.0002);
      const gain3 = calculateMakeupGain(0.00001);
      
      // All should be clamped to 2.0
      expect(gain1).toBe(2.0);
      expect(gain2).toBe(2.0);
      expect(gain3).toBe(2.0);
    });

    it('should handle RMS just above the floor threshold', () => {
      // RMS = 0.002 (above floor of 0.001)
      // gain = 0.3 / 0.002 = 150 -> clamped to 2.0
      expect(calculateMakeupGain(0.002)).toBe(2.0);
      
      // RMS = 0.01 (well above floor)
      // gain = 0.3 / 0.01 = 30 -> clamped to 2.0
      expect(calculateMakeupGain(0.01)).toBe(2.0);
      
      // RMS = 0.16 (above floor, below target)
      // gain = 0.3 / 0.16 = 1.875
      expect(calculateMakeupGain(0.16)).toBeCloseTo(1.875, 5);
    });
  });

  describe('Behavior with different floor values', () => {
    function calculateMakeupGainWithFloor(rmsAmplitude, floor = 1e-3) {
      const targetAmplitude = 0.3;
      let makeupGain = 1.0;
      if (rmsAmplitude < targetAmplitude) {
        const safeRms = Math.max(rmsAmplitude, floor);
        makeupGain = targetAmplitude / safeRms;
        makeupGain = Math.min(2.0, makeupGain);
      }
      return makeupGain;
    }

    it('should produce different results with different floor values', () => {
      const rms = 0.00001; // Very small RMS
      
      // With floor = 0.001, gain = 0.3/0.001 = 300 -> 2.0
      expect(calculateMakeupGainWithFloor(rms, 0.001)).toBe(2.0);
      
      // With floor = 0.01, gain = 0.3/0.01 = 30 -> 2.0
      expect(calculateMakeupGainWithFloor(rms, 0.01)).toBe(2.0);
      
      // With floor = 0.1, gain = 0.3/0.1 = 3 -> 2.0
      expect(calculateMakeupGainWithFloor(rms, 0.1)).toBe(2.0);
      
      // With floor = 0.15, gain = 0.3/0.15 = 2.0
      expect(calculateMakeupGainWithFloor(rms, 0.15)).toBe(2.0);
      
      // With floor = 0.2, gain = 0.3/0.2 = 1.5
      expect(calculateMakeupGainWithFloor(rms, 0.2)).toBeCloseTo(1.5, 5);
    });
  });
});
