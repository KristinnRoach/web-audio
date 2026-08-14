import { describe, it, expect, vi } from 'vitest';
import { CustomEnvelope } from '../CustomEnvelope';

// Mock AudioContext to bypass compatibility issues
const mockAudioContext = {
  currentTime: 0,
  createGain: () => ({ connect: () => {}, gain: { setValueAtTime: () => {} } }),
  createOscillator: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
  }),
} as unknown as AudioContext;

describe('CustomEnvelope Audio Discontinuity Test', () => {
  it('should NOT create audio discontinuity when baseValue != 1 and startFromValue is used', () => {
    // This test specifically targets the issue described in the suggestion
    const mockAudioParam = {
      value: 0.8, // Current AudioParam value
      setValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };

    const envelope = new CustomEnvelope(
      mockAudioContext,
      'amp-env',
      undefined,
      [
        { time: 0, value: 0.5, curve: 'exponential' }, // Different from AudioParam current value
        { time: 1, value: 1.0, curve: 'exponential' },
      ],
      [0, 1],
      1
    );

    // Trigger envelope with baseValue that would cause discontinuity
    envelope.triggerEnvelope(mockAudioParam as any, 0, {
      baseValue: 2, // THIS IS THE PROBLEM - this will multiply the startFromValue
      playbackRate: 1,
    });

    const curveCall = mockAudioParam.setValueCurveAtTime.mock.calls[0];
    const curve = curveCall[0] as Float32Array;

    const currentParamValue = mockAudioParam.value; // 0.8
    const firstCurveValue = curve[0]; // Should be 0.8, but might be 0.8 * 2 = 1.6!

    console.log('=== DISCONTINUITY BUG TEST ===');
    console.log('Current AudioParam value:', currentParamValue);
    console.log('First curve value:', firstCurveValue);
    console.log('BaseValue applied:', 2);
    console.log('Expected (no discontinuity):', currentParamValue);
    console.log('Actual:', firstCurveValue);

    const jump = Math.abs(firstCurveValue - currentParamValue);
    const percentageJump = (jump / currentParamValue) * 100;

    console.log('Value jump:', jump);
    console.log('Percentage jump:', percentageJump.toFixed(2) + '%');

    // This test should FAIL if the bug exists
    // The curve should start from the current AudioParam value WITHOUT baseValue multiplication
    expect(firstCurveValue).toBeCloseTo(currentParamValue, 5); // Should be 0.8, not 1.6
    expect(percentageJump).toBeCloseTo(0, 2); // No jump at all for smooth audio
  });

  it('should demonstrate the filter envelope discontinuity issue', () => {
    const mockAudioParam = {
      value: 5000, // Current filter frequency
      setValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };

    const envelope = new CustomEnvelope(
      mockAudioContext,
      'filter-env',
      undefined,
      [
        { time: 0, value: 2000, curve: 'exponential' },
        { time: 1, value: 8000, curve: 'exponential' },
      ],
      [20, 20000],
      1
    );

    // Trigger with baseValue that affects filter frequency
    envelope.triggerEnvelope(mockAudioParam as any, 0, {
      baseValue: 1.5, // Frequency modulation
      playbackRate: 1,
    });

    const curveCall = mockAudioParam.setValueCurveAtTime.mock.calls[0];
    const curve = curveCall[0] as Float32Array;

    const currentParamValue = mockAudioParam.value; // 5000 Hz
    const firstCurveValue = curve[0]; // Might be 5000 * 1.5 = 7500 Hz!

    console.log('=== FILTER DISCONTINUITY TEST ===');
    console.log('Current filter frequency:', currentParamValue, 'Hz');
    console.log('First curve frequency:', firstCurveValue, 'Hz');

    const jump = Math.abs(firstCurveValue - currentParamValue);
    const percentageJump = (jump / currentParamValue) * 100;

    console.log('Frequency jump:', jump, 'Hz');
    console.log('Percentage jump:', percentageJump.toFixed(2) + '%');

    // For filter frequencies, even small percentage jumps can be audible
    expect(firstCurveValue).toBeCloseTo(currentParamValue, 5); // Should start smoothly
    expect(percentageJump).toBeLessThan(1); // Less than 1% jump for smooth audio
  });
});
