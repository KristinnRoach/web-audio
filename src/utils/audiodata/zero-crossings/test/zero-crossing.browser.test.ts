import { describe, it, expect } from 'vitest';
import {
  findZeroCrossingSeconds,
  snapToNearestZeroCrossing,
} from '../zero-crossing';

import { findWaveCycles } from '../../wavecycles/findWaveCycles';

class MockAudioBuffer {
  constructor(
    public data: number[],
    public sampleRate = 44100
  ) {}
  getChannelData(channel: number) {
    return Float32Array.from(this.data);
  }
}

describe('zero-crossing utils', () => {
  it('findZeroCrossingSeconds detects zero crossings', () => {
    const buffer = new MockAudioBuffer([1, -1, 1, -1]);
    const crossings = findZeroCrossingSeconds(buffer as any);
    expect(crossings.length).toBeGreaterThan(0);
  });

  it('snapToNearestZeroCrossing returns closest crossing', () => {
    const crossings = [0.01, 0.02, 0.03];
    expect(snapToNearestZeroCrossing(0.025, crossings)).toBeCloseTo(0.03);
  });

  it('findWaveCycles returns cycles', () => {
    const buffer = new MockAudioBuffer([1, -1, 1, -1]);
    const cycles = findWaveCycles(buffer as any);
    expect(Array.isArray(cycles)).toBe(true);
  });

  it('findWaveCycles pairs cycles by direction', () => {
    // Asymmetric waveform: up through zero at 0, down at 2, up at 4, down at 6
    const buffer = new MockAudioBuffer([0, 1, 0, -1, 0, 1, 0, -1]);
    const cycles = findWaveCycles(buffer as any);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].startSample).toBeLessThan(cycles[0].endSample);
    // Assert actual values returned by the function
    expect([0, 2]).toContain(cycles[0].startSample);
    expect([4, 6]).toContain(cycles[0].endSample);
  });
});
