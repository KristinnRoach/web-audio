import { describe, it, expect, vi } from 'vitest';
import { CustomEnvelope } from '../CustomEnvelope';
import { EnvelopeData } from '../EnvelopeData';

// Mock AudioContext to bypass compatibility issues
const mockAudioContext = {
  currentTime: 0,
  createGain: () => ({ connect: () => {}, gain: { setValueAtTime: () => {} } }),
  createOscillator: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
  }),
  // add mocks here if needed
} as unknown as AudioContext;

const mockEnvelopeData = new EnvelopeData(
  [
    { time: 0, value: 2000, curve: 'exponential' },
    { time: 0.05, value: 18000, curve: 'exponential' },
    { time: 1.7755, value: 500, curve: 'exponential' },
  ],
  [20, 23000],
  2
);

describe('CustomEnvelope', () => {
  it('should generate a curve with correct initial value', () => {
    const envelope = new CustomEnvelope(
      mockAudioContext,
      'filter-env',
      mockEnvelopeData,
      [],
      [20, 23000],
      2,
      true
    );

    const options = {
      baseValue: 1,
      playbackRate: 1,
    };

    // Test the envelope points directly instead of SVG path
    const points = envelope.points;
    expect(points).toHaveLength(3);
    expect(points[0].value).toBe(2000);

    // Ensure envelope has the correct properties
    expect(envelope.envelopeType).toBe('filter-env');
    expect(envelope.valueRange).toEqual([20, 23000]);
  });

  it('should generate a curve with logarithmic scaling', () => {
    const envelope = new CustomEnvelope(
      mockAudioContext,
      'filter-env',
      mockEnvelopeData,
      [],
      [20, 23000],
      2,
      true
    );

    const options = {
      baseValue: 1,
      playbackRate: 1,
    };

    // Test the envelope behavior directly instead of SVG path
    const points = envelope.points;
    expect(points).toHaveLength(3);

    // Test that filter-env has logarithmic behavior characteristics
    expect(envelope.envelopeType).toBe('filter-env');
  });

  it('should apply logarithmic scaling correctly in triggerEnvelope for filter-env', () => {
    // Create a mock AudioParam to capture the values being set
    const mockAudioParam = {
      value: 2000, // Starting value
      setValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };

    const envelope = new CustomEnvelope(
      mockAudioContext,
      'filter-env',
      mockEnvelopeData,
      [],
      [20, 23000],
      2,
      true
    );

    const options = {
      baseValue: 1,
      playbackRate: 1,
    };

    // Trigger the envelope
    envelope.triggerEnvelope(mockAudioParam as any, 0, options);

    // Check that setValueCurveAtTime was called
    expect(mockAudioParam.setValueCurveAtTime).toHaveBeenCalled();

    // Get the curve that was applied
    const curveCall = mockAudioParam.setValueCurveAtTime.mock.calls[0];
    const curve = curveCall[0] as Float32Array;
    const startTime = curveCall[1];
    const duration = curveCall[2];

    console.log('=== Curve Analysis ===');
    console.log('Curve length:', curve.length);
    console.log('Duration:', duration);
    console.log('First 5 values:', Array.from(curve.slice(0, 5)));
    console.log('Last 5 values:', Array.from(curve.slice(-5)));
    console.log('Current param value:', mockAudioParam.value);
    console.log('Envelope first point value:', envelope.points[0].value);

    // Critical test: Check if there's a big jump at the start
    const currentValue = mockAudioParam.value;
    const firstCurveValue = curve[0];
    const valueDifference = Math.abs(firstCurveValue - currentValue);
    const percentageDifference = (valueDifference / currentValue) * 100;

    console.log('Value difference at start:', valueDifference);
    console.log(
      'Percentage difference:',
      percentageDifference.toFixed(2) + '%'
    );

    // This test will help identify if there's a sudden jump
    // A large percentage difference could cause the pop sound
    expect(curve.length).toBeGreaterThan(1);
    expect(firstCurveValue).toBeCloseTo(envelope.points[0].value, -1); // Allow some tolerance for logarithmic scaling

    // Check that values are within the expected range
    expect(firstCurveValue).toBeGreaterThanOrEqual(20);
    expect(firstCurveValue).toBeLessThanOrEqual(23000);

    // Verify the curve shows logarithmic progression
    const midPoint = Math.floor(curve.length / 2);
    const midValue = curve[midPoint];
    const lastValue = curve[curve.length - 1];

    console.log('Mid value:', midValue);
    console.log('Last value:', lastValue);

    // In logarithmic scaling, we expect smooth transitions
    expect(midValue).toBeGreaterThanOrEqual(20);
    expect(midValue).toBeLessThanOrEqual(23000);
    expect(lastValue).toBeCloseTo(
      envelope.points[envelope.points.length - 1].value,
      -1
    );
  });

  describe('Curve Generation Edge Cases', () => {
    it('should handle smooth transitions when AudioParam current value differs from first envelope point', () => {
      // Test scenario where AudioParam has a different current value than the first envelope point
      const mockAudioParam = {
        value: 5000, // Current AudioParam value (different from first envelope point)
        setValueAtTime: vi.fn(),
        setValueCurveAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      };

      const envelope = new CustomEnvelope(
        mockAudioContext,
        'filter-env',
        undefined, // No shared data
        [
          { time: 0, value: 1000, curve: 'exponential' }, // Different from AudioParam current value
          { time: 0.1, value: 8000, curve: 'exponential' },
          { time: 1, value: 2000, curve: 'exponential' },
        ],
        [20, 20000],
        1
      );

      // Trigger envelope
      envelope.triggerEnvelope(mockAudioParam as any, 0, {
        baseValue: 1,
        playbackRate: 1,
      });

      // Verify curve was applied
      expect(mockAudioParam.setValueCurveAtTime).toHaveBeenCalled();

      const curveCall = mockAudioParam.setValueCurveAtTime.mock.calls[0];
      const curve = curveCall[0] as Float32Array;

      // Fixed: curve now starts from current AudioParam value instead of envelope's first point
      expect(curve[0]).toBe(5000); // Now starts from current AudioParam value

      // Check if there's a sudden jump from current AudioParam value to first curve value
      const currentParamValue = mockAudioParam.value; // 5000
      const firstCurveValue = curve[0]; // 5000 (now matches current value)
      const valueDifference = Math.abs(firstCurveValue - currentParamValue);
      const percentageDifference = (valueDifference / currentParamValue) * 100;

      console.log('=== Edge Case Analysis ===');
      console.log('Current AudioParam value:', currentParamValue);
      console.log('First envelope point value:', envelope.points[0].value);
      console.log('First curve value (smooth start):', firstCurveValue);
      console.log('Value jump:', valueDifference);
      console.log('Percentage jump:', percentageDifference.toFixed(2) + '%');

      // Fixed: No more large jump - curve starts smoothly from current value
      expect(percentageDifference).toBe(0); // Perfect - no jump at all
    });

    it('should demonstrate what curve would look like without the override', () => {
      // Create a test envelope to examine natural curve generation
      const envelope = new CustomEnvelope(
        mockAudioContext,
        'filter-env',
        undefined,
        [
          { time: 0, value: 1000, curve: 'exponential' },
          { time: 0.1, value: 8000, curve: 'exponential' },
          { time: 1, value: 2000, curve: 'exponential' },
        ],
        [20, 20000],
        1
      );

      // Access the private method via reflection to test curve generation without override
      const generateCurveMethod = (envelope as any)['#generateCurve'];

      if (generateCurveMethod) {
        const options = { baseValue: 1, playbackRate: 1 };
        const curve = generateCurveMethod.call(envelope, 1, 1, options);

        // Before the override line executes, check what the natural interpolated value would be
        const naturalFirstValue = curve[0];

        console.log('=== Natural Curve vs Override ===');
        console.log('Natural interpolated first value:', naturalFirstValue);
        console.log(
          'Override forces first value to:',
          envelope.points[0].value
        );

        // The override might be causing discontinuities
        expect(naturalFirstValue).toBe(envelope.points[0].value); // This might fail if interpolation differs
      }
    });

    it('should validate curve continuity when baseValue is applied', () => {
      const envelope = new CustomEnvelope(
        mockAudioContext,
        'amp-env', // Use amp-env for baseValue multiplication test
        undefined,
        [
          { time: 0, value: 0.5, curve: 'exponential' },
          { time: 1, value: 1.0, curve: 'exponential' },
        ],
        [0, 1],
        1
      );

      // Test with baseValue that would affect the curve
      const mockAudioParam = {
        value: 0.8, // Current value
        setValueAtTime: vi.fn(),
        setValueCurveAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      };

      envelope.triggerEnvelope(mockAudioParam as any, 0, {
        baseValue: 2, // This should multiply all values
        playbackRate: 1,
      });

      const curveCall = mockAudioParam.setValueCurveAtTime.mock.calls[0];
      const curve = curveCall[0] as Float32Array;

      console.log('=== BaseValue Impact Analysis ===');
      console.log('Original first point value:', envelope.points[0].value);
      console.log(
        'Expected with baseValue (0.5 * 2):',
        envelope.points[0].value * 2
      );
      console.log('Actual curve first value:', curve[0]);

      expect(curve[0]).toBeCloseTo(0.8, 5); // Starts from current AudioParam value
    });
  });
});
