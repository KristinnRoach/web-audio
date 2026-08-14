import { describe, it, expect } from 'vitest';
import { findClosest } from '../index';
import { ValueSnapper } from '../../../nodes/params/helpers/ValueSnapper';

describe('findClosest ValueSnapper Integration', () => {
  // Mock the exact reduce pattern from ValueSnapper.snapToValue
  const snapToValueOriginal = (
    target: number,
    allowedValues: number[]
  ): number => {
    if (allowedValues.length === 0) return target;

    return allowedValues.reduce((prev, curr) =>
      Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
    );
  };

  // Proposed replacement using findClosest
  const snapToValueWithFindClosest = (
    target: number,
    allowedValues: number[]
  ): number => {
    if (allowedValues.length === 0) return target;

    return findClosest(allowedValues, target, (x) => x);
  };

  // Proposed replacement using findClosest with default parameter
  const snapToValueWithFindClosestDefault = (
    target: number,
    allowedValues: number[]
  ): number => {
    if (allowedValues.length === 0) return target;

    return findClosest(allowedValues, target); // No need for (x) => x!
  };

  describe('Behavioral Compatibility', () => {
    it('produces identical results for typical ValueSnapper use cases', () => {
      const testCases = [
        // Musical scale values (common in ValueSnapper)
        {
          values: [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88],
          target: 370,
        },
        {
          values: [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88],
          target: 440,
        },
        {
          values: [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88],
          target: 300,
        },

        // Audio periods (seconds)
        { values: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1], target: 0.007 },
        { values: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1], target: 0.001 },
        { values: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1], target: 0.15 },

        // Normalized values (0-1 range)
        {
          values: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
          target: 0.33,
        },
        {
          values: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
          target: 0.95,
        },

        // Edge cases
        { values: [1], target: 100 },
        { values: [1, 2], target: 1.5 },
        { values: [1, 1, 1], target: 1 }, // Duplicates
        { values: [-5, -2, 0, 2, 5], target: -1 }, // Negative values
      ];

      testCases.forEach(({ values, target }, index) => {
        const originalResult = snapToValueOriginal(target, values);
        const findClosestResult = snapToValueWithFindClosest(target, values);
        const findClosestDefaultResult = snapToValueWithFindClosestDefault(
          target,
          values
        );

        expect(findClosestResult).toBe(originalResult);
        expect(findClosestDefaultResult).toBe(originalResult);
      });
    });

    it('handles empty arrays identically', () => {
      const target = 42;
      const emptyArray: number[] = [];

      const originalResult = snapToValueOriginal(target, emptyArray);
      const findClosestResult = snapToValueWithFindClosest(target, emptyArray);
      const findClosestDefaultResult = snapToValueWithFindClosestDefault(
        target,
        emptyArray
      );

      expect(findClosestResult).toBe(originalResult);
      expect(findClosestDefaultResult).toBe(originalResult);
      expect(findClosestResult).toBe(target);
    });

    it('handles tie-breaking identically', () => {
      // Test cases where target is exactly between two values
      const testCases = [
        { values: [10, 30], target: 20 }, // Exactly between
        { values: [1, 3, 5], target: 2 }, // Closer to first
        { values: [1, 3, 5], target: 4 }, // Closer to second
        { values: [0, 2, 4, 6], target: 3 }, // Exactly between middle values
      ];

      testCases.forEach(({ values, target }) => {
        const originalResult = snapToValueOriginal(target, values);
        const findClosestResult = snapToValueWithFindClosest(target, values);
        const findClosestDefaultResult = snapToValueWithFindClosestDefault(
          target,
          values
        );

        expect(findClosestResult).toBe(originalResult);
        expect(findClosestDefaultResult).toBe(originalResult);
      });
    });
  });

  describe('Performance Characteristics', () => {
    it('demonstrates performance improvement for realistic ValueSnapper scales', () => {
      // Generate a realistic musical scale with multiple octaves
      const generateChromaticScale = (startNote = 27.5, octaves = 8) => {
        const notes: number[] = [];
        for (let octave = 0; octave < octaves; octave++) {
          for (let semitone = 0; semitone < 12; semitone++) {
            const frequency = startNote * Math.pow(2, octave + semitone / 12);
            notes.push(frequency);
          }
        }
        return notes.sort((a, b) => a - b);
      };

      const chromaticScale = generateChromaticScale(); // 96 notes
      const target = 440; // A4
      const iterations = 1000;

      // Time original approach
      const originalStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        snapToValueOriginal(target + i * 0.1, chromaticScale);
      }
      const originalTime = performance.now() - originalStart;

      // Time findClosest approach
      const findClosestStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        snapToValueWithFindClosest(target + i * 0.1, chromaticScale);
      }
      const findClosestTime = performance.now() - findClosestStart;

      // Time findClosest with default parameter approach
      const findClosestDefaultStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        snapToValueWithFindClosestDefault(target + i * 0.1, chromaticScale);
      }
      const findClosestDefaultTime =
        performance.now() - findClosestDefaultStart;

      console.log(`Musical scale (96 notes, ${iterations} searches):`);
      console.log(`Original: ${originalTime.toFixed(2)}ms`);
      console.log(`FindClosest: ${findClosestTime.toFixed(2)}ms`);
      console.log(
        `FindClosest (default): ${findClosestDefaultTime.toFixed(2)}ms`
      );
      console.log(
        `Speedup (FindClosest): ${(originalTime / findClosestTime).toFixed(1)}x`
      );
      console.log(
        `Speedup (FindClosest default): ${(originalTime / findClosestDefaultTime).toFixed(1)}x`
      );

      // Verify results are identical
      const originalResult = snapToValueOriginal(target, chromaticScale);
      const findClosestResult = snapToValueWithFindClosest(
        target,
        chromaticScale
      );
      const findClosestDefaultResult = snapToValueWithFindClosestDefault(
        target,
        chromaticScale
      );
      expect(findClosestResult).toBe(originalResult);
      expect(findClosestDefaultResult).toBe(originalResult);

      // Performance should improve with larger scales
      expect(findClosestTime).toBeLessThan(originalTime);
      expect(findClosestDefaultTime).toBeLessThan(originalTime);
    });
  });

  describe('Real ValueSnapper Integration', () => {
    it('works with actual ValueSnapper instance', () => {
      const snapper = new ValueSnapper();

      // Set up a pentatonic scale
      const pentatonicFreqs = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
      snapper.setAllowedValues(pentatonicFreqs, false);

      // Test the original snapToValue method
      const originalResult = snapper.snapToValue(350);

      // Test what findClosest would return
      const findClosestResult = findClosest(pentatonicFreqs, 350, (x) => x);
      const findClosestDefaultResult = findClosest(pentatonicFreqs, 350);

      expect(findClosestResult).toBe(originalResult);
      expect(findClosestDefaultResult).toBe(originalResult);
      expect(findClosestResult).toBe(329.63); // Should snap to E4
    });

    it('handles normalized ranges correctly', () => {
      const snapper = new ValueSnapper();

      // Test with normalized values (common ValueSnapper use case)
      const normalizedValues = [
        0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0,
      ];
      snapper.setAllowedValues(normalizedValues, false);

      const testTargets = [0.1, 0.33, 0.67, 0.9];

      testTargets.forEach((target) => {
        const originalResult = snapper.snapToValue(target);
        const findClosestResult = findClosest(
          normalizedValues,
          target,
          (x) => x
        );
        const findClosestDefaultResult = findClosest(normalizedValues, target);

        expect(findClosestResult).toBe(originalResult);
        expect(findClosestDefaultResult).toBe(originalResult);
      });
    });

    it('works with default parameter (no getValue needed)', () => {
      const snapper = new ValueSnapper();

      const testCases = [
        { values: [1, 5, 10, 20], target: 7 },
        { values: [0.1, 0.2, 0.3, 0.4], target: 0.25 },
        { values: [100, 200, 300], target: 250 },
      ];

      testCases.forEach(({ values, target }) => {
        const originalResult = snapToValueOriginal(target, values);
        const explicitResult = snapToValueWithFindClosest(target, values);
        const defaultResult = snapToValueWithFindClosestDefault(target, values);

        // All three approaches should return the same result
        expect(defaultResult).toBe(originalResult);
        expect(defaultResult).toBe(explicitResult);
      });
    });
  });

  describe('Edge Cases and Robustness', () => {
    it('handles floating point precision like original', () => {
      const values = [0.1, 0.2, 0.3]; // Known floating point precision issues
      const target = 0.15;

      const originalResult = snapToValueOriginal(target, values);
      const findClosestResult = snapToValueWithFindClosest(target, values);
      const findClosestDefaultResult = snapToValueWithFindClosestDefault(
        target,
        values
      );

      expect(findClosestResult).toBe(originalResult);
      expect(findClosestDefaultResult).toBe(originalResult);
    });

    it('handles very small and very large values', () => {
      const testCases = [
        { values: [1e-10, 1e-9, 1e-8], target: 5e-10 },
        { values: [1e10, 1e11, 1e12], target: 5e10 },
      ];

      testCases.forEach(({ values, target }) => {
        const originalResult = snapToValueOriginal(target, values);
        const findClosestResult = snapToValueWithFindClosest(target, values);
        const findClosestDefaultResult = snapToValueWithFindClosestDefault(
          target,
          values
        );

        expect(findClosestResult).toBe(originalResult);
        expect(findClosestDefaultResult).toBe(originalResult);
      });
    });

    it('maintains array sorting assumption', () => {
      // ValueSnapper explicitly sorts its arrays, but let's verify findClosest
      // works correctly with the sorted arrays it will receive
      const unsorted = [5, 1, 3, 2, 4];
      const sorted = [...unsorted].sort((a, b) => a - b);

      const target = 2.5;

      const sortedResult = findClosest(sorted, target, (x) => x);
      const originalSortedResult = snapToValueOriginal(target, sorted);

      expect(sortedResult).toBe(originalSortedResult);
      expect(sortedResult).toBe(2); // Should be 2, not 3
    });
  });

  describe('Memory and Performance Safety', () => {
    it('does not modify input arrays', () => {
      const originalArray = [1, 2, 3, 4, 5];
      const arrayCopy = [...originalArray];

      findClosest(originalArray, 3.5, (x) => x);

      expect(originalArray).toEqual(arrayCopy);
    });

    it('handles repeated calls efficiently', () => {
      const values = Array.from({ length: 1000 }, (_, i) => i);
      const calls = 10000;

      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        findClosest(values, Math.random() * 1000, (x) => x);
      }
      const time = performance.now() - start;

      console.log(`${calls} calls on 1000-element array: ${time.toFixed(2)}ms`);
      expect(time).toBeLessThan(100); // Should be very fast
    });
  });
});
