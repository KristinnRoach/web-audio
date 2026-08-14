import { describe, it, expect } from 'vitest';
import { findClosest } from '../index';

describe('findClosest', () => {
  // Helper function for simple reduce-based approach (from ValueSnapper.ts)
  const findClosestNaive = <T>(
    array: T[],
    target: number,
    getValue: (item: T) => number
  ): T => {
    return array.reduce((prev, curr) =>
      Math.abs(getValue(curr) - target) < Math.abs(getValue(prev) - target)
        ? curr
        : prev
    );
  };

  // Test data generators
  const generateSortedNumbers = (count: number): number[] => {
    return Array.from({ length: count }, (_, i) => i * 2); // [0, 2, 4, 6, 8, ...]
  };

  const generateSortedObjects = (count: number) => {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      value: i * 3.5 + Math.random() * 0.1, // Slight randomness to test floating point
      name: `item_${i}`,
    }));
  };

  const generateMusicalFrequencies = () => {
    // Generate musical frequencies (A4 = 440Hz and surrounding notes)
    return [
      { note: 'A3', frequency: 220.0 },
      { note: 'A#3', frequency: 233.08 },
      { note: 'B3', frequency: 246.94 },
      { note: 'C4', frequency: 261.63 },
      { note: 'C#4', frequency: 277.18 },
      { note: 'D4', frequency: 293.66 },
      { note: 'D#4', frequency: 311.13 },
      { note: 'E4', frequency: 329.63 },
      { note: 'F4', frequency: 349.23 },
      { note: 'F#4', frequency: 369.99 },
      { note: 'G4', frequency: 392.0 },
      { note: 'G#4', frequency: 415.3 },
      { note: 'A4', frequency: 440.0 },
      { note: 'A#4', frequency: 466.16 },
      { note: 'B4', frequency: 493.88 },
      { note: 'C5', frequency: 523.25 },
    ];
  };

  describe('Basic Functionality', () => {
    it('finds exact match in sorted number array', () => {
      const array = [1, 3, 5, 7, 9];
      const result = findClosest(array, 5, 'any', (x) => x);
      expect(result).toBe(5);
    });

    it('finds closest value when target is between elements', () => {
      const array = [1, 3, 5, 7, 9];
      const result = findClosest(array, 4, 'any', (x) => x);
      expect(result).toBe(3); // 4 is closer to 3 than to 5
    });

    it('finds closest value when target is exactly between two elements', () => {
      const array = [1, 3, 5, 7, 9];
      const result = findClosest(array, 4, 'any', (x) => x); // Exactly between 3 and 5
      expect(result).toBe(3); // Should prefer left element when distances are equal
    });

    it('works with object arrays using getValue function', () => {
      const items = [
        { id: 1, value: 10 },
        { id: 2, value: 20 },
        { id: 3, value: 30 },
        { id: 4, value: 40 },
      ];
      const result = findClosest(items, 25, 'any', (item) => item.value);
      expect(result.id).toBe(2); // value: 20 is closest to 25
    });
  });

  describe('Edge Cases', () => {
    it('throws error for empty array', () => {
      expect(() => findClosest([], 5, 'any', (x) => x)).toThrow(
        'Array cannot be empty'
      );
    });

    it('returns single element for single-element array', () => {
      const array = [42];
      const result = findClosest(array, 1000, 'any', (x) => x);
      expect(result).toBe(42);
    });

    it('handles target below range', () => {
      const array = [10, 20, 30, 40];
      const result = findClosest(array, 5, 'any', (x) => x);
      expect(result).toBe(10);
    });

    it('handles target above range', () => {
      const array = [10, 20, 30, 40];
      const result = findClosest(array, 100, 'any', (x) => x);
      expect(result).toBe(40);
    });

    it('handles negative numbers correctly', () => {
      const array = [-50, -20, -10, 0, 10, 20, 50];
      const result = findClosest(array, -15, 'any', (x) => x);
      expect(result).toBe(-20);
    });

    it('handles floating point precision', () => {
      const array = [0.1, 0.2, 0.3, 0.4, 0.5];
      const result = findClosest(array, 0.25, 'any', (x) => x);
      expect(result).toBe(0.2);
    });

    it('handles very large numbers', () => {
      const array = [1e6, 1e7, 1e8, 1e9];
      const result = findClosest(array, 5e7, 'any', (x) => x);
      expect(result).toBe(1e7);
    });

    it('handles duplicate values', () => {
      const array = [1, 2, 2, 2, 3];
      const result = findClosest(array, 2.1, 'any', (x) => x);
      expect(result).toBe(2);
    });
  });

  describe('Custom Distance Function', () => {
    it('uses custom distance function for logarithmic scale', () => {
      // For musical frequencies, logarithmic distance is more appropriate
      const frequencies = [220, 440, 880]; // A3, A4, A5 (octaves)
      const logDistance = (a: number, b: number) =>
        Math.abs(Math.log2(a) - Math.log2(b));

      // Target is 330Hz - closer to 220 in log scale than 440
      const result = findClosest(
        frequencies,
        330,
        'any',
        (x) => x,
        logDistance
      );
      expect(result).toBe(440); // In log scale, 330 is closer to 440
    });

    it('uses custom distance for wrapped circular values', () => {
      // For circular values like angles (0-360 degrees)
      const angles = [10, 90, 180, 270, 350];
      const circularDistance = (a: number, b: number) => {
        const diff = Math.abs(a - b);
        return Math.min(diff, 360 - diff);
      };

      const result = findClosest(angles, 5, 'any', (x) => x, circularDistance);
      expect(result).toBe(10); // 5 is closer to 10 than to 350 in circular distance
    });
  });

  describe('Performance vs Naive Implementation', () => {
    const sizes = [100, 1000, 10000];

    sizes.forEach((size) => {
      it(`performs better than naive approach for array size ${size}`, () => {
        const array = generateSortedNumbers(size);
        const target = Math.random() * size * 2;
        const iterations = 1000;

        // Warm up
        for (let i = 0; i < 10; i++) {
          findClosest(array, target, 'any', (x) => x);
          findClosestNaive(array, target, (x) => x);
        }

        // Time binary search approach
        const binaryStart = performance.now();
        for (let i = 0; i < iterations; i++) {
          findClosest(array, target + i * 0.1, 'any', (x) => x);
        }
        const binaryTime = performance.now() - binaryStart;

        // Time naive approach
        const naiveStart = performance.now();
        for (let i = 0; i < iterations; i++) {
          findClosestNaive(array, target + i * 0.1, (x) => x);
        }
        const naiveTime = performance.now() - naiveStart;

        // Binary search should be significantly faster for larger arrays
        if (size >= 1000) {
          expect(binaryTime).toBeLessThan(naiveTime);
          console.log(
            `Size ${size}: Binary ${binaryTime.toFixed(2)}ms vs Naive ${naiveTime.toFixed(2)}ms (${(naiveTime / binaryTime).toFixed(1)}x faster)`
          );
        }

        // Both should return same results
        const binaryResult = findClosest(array, target, 'any', (x) => x);
        const naiveResult = findClosestNaive(array, target, (x) => x);
        expect(binaryResult).toBe(naiveResult);
      });
    });

    // ponytail: wall-clock ratio assertions are noise on shared CI runners
    // (observed naive "ratio" < 1 across a 10x size increase); kept for local
    // benchmarking only.
    it.skip('demonstrates O(log n) vs O(n) complexity', () => {
      const sizes = [1000, 10000, 100000];
      const times: number[] = [];
      const naiveTimes: number[] = [];

      // Warm up
      const warmupArray = generateSortedNumbers(1000);
      for (let i = 0; i < 1000; i++) {
        findClosest(warmupArray, i, 'any', (x) => x);
        findClosestNaive(warmupArray, i, (x) => x);
      }

      sizes.forEach((size) => {
        const array = generateSortedNumbers(size);
        const iterations = size <= 10000 ? 1000 : 100; // More iterations for smaller sizes
        let totalBinaryTime = 0;
        let totalNaiveTime = 0;

        // Multiple runs to get average
        for (let run = 0; run < 5; run++) {
          const targets = Array.from(
            { length: iterations },
            () => Math.random() * size
          );

          // Time binary search
          const start = performance.now();
          for (const target of targets) {
            findClosest(array, target, 'any', (x) => x);
          }
          totalBinaryTime += performance.now() - start;

          // Time naive approach (fewer iterations for largest size)
          const naiveIterations = size > 50000 ? iterations / 10 : iterations;
          const naiveTargets = targets.slice(0, naiveIterations);
          const naiveStart = performance.now();
          for (const target of naiveTargets) {
            findClosestNaive(array, target, (x) => x);
          }
          totalNaiveTime +=
            (performance.now() - naiveStart) * (iterations / naiveIterations);
        }

        times.push(totalBinaryTime / 5);
        naiveTimes.push(totalNaiveTime / 5);
      });

      // Binary search should scale logarithmically
      const binaryRatio1 = times[1] / times[0]; // 10x size increase
      const binaryRatio2 = times[2] / times[1]; // 10x size increase

      // Naive should scale linearly
      const naiveRatio1 = naiveTimes[1] / naiveTimes[0];
      const naiveRatio2 = naiveTimes[2] / naiveTimes[1];

      // Binary search ratios should be much smaller than naive ratios
      expect(binaryRatio1).toBeLessThan(naiveRatio1 / 2);
      expect(binaryRatio2).toBeLessThan(naiveRatio2 / 2);

      console.log('Complexity analysis:');
      console.log(
        `Binary ratios: ${binaryRatio1.toFixed(2)}, ${binaryRatio2.toFixed(2)}`
      );
      console.log(
        `Naive ratios: ${naiveRatio1.toFixed(2)}, ${naiveRatio2.toFixed(2)}`
      );
    });
  });

  describe('Real-world Use Cases', () => {
    it('finds closest musical note to frequency', () => {
      const notes = generateMusicalFrequencies();

      // Test finding A4 (440Hz) exactly
      const exactResult = findClosest(
        notes,
        440,
        'any',
        (note) => note.frequency
      );
      expect(exactResult.note).toBe('A4');

      // Test finding closest to 435Hz (should be A4)
      const closeResult = findClosest(
        notes,
        435,
        'any',
        (note) => note.frequency
      );
      expect(closeResult.note).toBe('A4');

      // Test finding closest to 260Hz (should be C4)
      const c4Result = findClosest(notes, 260, 'any', (note) => note.frequency);
      expect(c4Result.note).toBe('C4');
    });

    it('handles time-based searches efficiently', () => {
      // Simulate audio sample timestamps
      const timestamps = Array.from({ length: 10000 }, (_, i) => ({
        sampleIndex: i,
        timeSeconds: i / 44100, // 44.1kHz sample rate
        amplitude: Math.sin(i * 0.01),
      }));

      const targetTime = 0.5; // 0.5 seconds
      const result = findClosest(
        timestamps,
        targetTime,
        'any',
        (sample) => sample.timeSeconds
      );

      // Since we only have 10000 samples (~0.227 seconds), find the closest available
      const expectedIndex = Math.min(9999, Math.round(targetTime * 44100));
      expect(result.sampleIndex).toBe(expectedIndex);
      expect(result.timeSeconds).toBeCloseTo(expectedIndex / 44100, 5);
    });

    it('works with sparse data sets', () => {
      const sparseData = [
        { x: 0, y: 0 },
        { x: 100, y: 1 },
        { x: 500, y: 2 },
        { x: 1000, y: 3 },
        { x: 10000, y: 4 },
      ];

      // Target 300 is equidistant from 100 and 500, function prefers left element
      const result = findClosest(sparseData, 300, 'any', (point) => point.x);
      expect(result.x).toBe(100);
      expect(result.y).toBe(1);

      // Test with target closer to 500
      const result2 = findClosest(sparseData, 450, 'any', (point) => point.x);
      expect(result2.x).toBe(500);
      expect(result2.y).toBe(2);
    });
  });

  describe('Robustness Tests', () => {
    it('handles unsorted array gracefully', () => {
      // Note: The function expects sorted arrays, but let's test what happens
      const unsorted = [5, 1, 9, 3, 7];
      // This might not work correctly, but shouldn't crash
      expect(() => findClosest(unsorted, 4, 'any', (x) => x)).not.toThrow();
    });

    it('handles NaN and Infinity values', () => {
      const arrayWithSpecial = [1, 5, 10, Infinity];
      const result = findClosest(arrayWithSpecial, 100, 'any', (x) => x);
      // For target 100: distances are |1-100|=99, |5-100|=95, |10-100|=90, |Infinity-100|=Infinity
      // So 10 is actually closest
      expect(result).toBe(10);

      // Test where Infinity would be closest - use Infinity as target
      const result2 = findClosest(arrayWithSpecial, Infinity, 'any', (x) => x);
      expect(result2).toBe(Infinity);

      const arrayWithNaN = [1, 5, 10];
      const resultNaN = findClosest(arrayWithNaN, NaN, 'any', (x) => x);
      // Should handle NaN gracefully (result might be unpredictable but shouldn't crash)
      expect(typeof resultNaN).toBe('number');
    });

    it('maintains referential equality for objects', () => {
      const objects = [
        { id: 1, value: 10 },
        { id: 2, value: 20 },
        { id: 3, value: 30 },
      ];

      const result = findClosest(objects, 15, 'any', (obj) => obj.value);
      expect(result).toBe(objects[0]); // Should return exact reference
    });

    it('handles extremely large arrays', () => {
      const largeArray = generateSortedNumbers(100000);
      const target = 123456;

      const start = performance.now();
      const result = findClosest(largeArray, target, 'any', (x) => x);
      const time = performance.now() - start;

      expect(result).toBeCloseTo(target, 0);
      expect(time).toBeLessThan(10); // Should complete in under 10ms
    });

    it('works consistently with different data types', () => {
      // Test with strings representing numbers
      const stringNumbers = ['1', '10', '100', '1000'];
      const result = findClosest(stringNumbers, 50, 'any', (s) => parseInt(s));
      expect(result).toBe('10');

      // Test with dates
      const dates = [
        new Date('2023-01-01'),
        new Date('2023-06-01'),
        new Date('2023-12-01'),
      ];
      const targetDate = new Date('2023-08-01').getTime();
      const dateResult = findClosest(dates, targetDate, 'any', (d) =>
        d.getTime()
      );
      expect(dateResult.getMonth()).toBe(5); // June (0-indexed)
    });
  });

  describe('Stress Tests', () => {
    it('handles rapid successive calls efficiently', () => {
      const array = generateSortedNumbers(1000);
      const calls = 10000;

      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        findClosest(array, Math.random() * 2000, 'any', (x) => x);
      }
      const time = performance.now() - start;

      expect(time).toBeLessThan(100); // Should handle 10k calls in under 100ms
      console.log(`${calls} calls completed in ${time.toFixed(2)}ms`);
    });

    it('maintains accuracy with floating point arithmetic', () => {
      const preciseArray = Array.from(
        { length: 1000 },
        (_, i) => (i * Math.PI) / 1000
      );
      const target = Math.E; // Irrational number

      const result = findClosest(preciseArray, target, 'any', (x) => x);
      const binaryDistance = Math.abs(result - target);

      const naiveResult = findClosestNaive(preciseArray, target, (x) => x);
      const naiveDistance = Math.abs(naiveResult - target);

      expect(binaryDistance).toBeCloseTo(naiveDistance, 10);
    });
  });

  describe('Default Parameter Convenience', () => {
    it('works with default getValue for number arrays', () => {
      const numbers = [1, 5, 10, 15, 20];

      // Test with default parameter (no getValue needed)
      const resultWithDefault = findClosest(numbers, 12);

      // Test with explicit parameter (should be identical)
      const resultWithExplicit = findClosest(numbers, 12, 'any', (x) => x);

      expect(resultWithDefault).toBe(10);
      expect(resultWithDefault).toBe(resultWithExplicit);
    });

    it('still works with explicit getValue for object arrays', () => {
      const objects = [
        { value: 1 },
        { value: 5 },
        { value: 10 },
        { value: 15 },
        { value: 20 },
      ];

      const result = findClosest(objects, 12, 'any', (obj) => obj.value);
      expect(result.value).toBe(10);
    });

    it('maintains backwards compatibility', () => {
      const numbers = [1, 3, 5, 7, 9];

      // All these should produce the same result
      const defaultResult = findClosest(numbers, 4);
      const explicitResult = findClosest(numbers, 4, 'any', (x) => x);
      const withDistanceResult = findClosest(
        numbers,
        4,
        'any',
        (x) => x,
        (a, b) => Math.abs(a - b)
      );

      expect(defaultResult).toBe(3);
      expect(explicitResult).toBe(3);
      expect(withDistanceResult).toBe(3);
    });
  });
});
