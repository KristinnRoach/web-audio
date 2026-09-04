import { describe, it, expect } from "vite-plus/test";
import { findZeroCrossings } from "../zero-crossing";

import { findWaveCycles } from "../../wavecycles/findWaveCycles";

class MockAudioBuffer {
  constructor(
    public data: number[],
    public sampleRate = 44100,
  ) {}
  getChannelData(channel: number) {
    return Float32Array.from(this.data);
  }
}

describe("zero-crossing utils", () => {
  it("findZeroCrossings detects zero crossings in seconds", () => {
    const buffer = new MockAudioBuffer([1, -1, 1, -1]);
    const crossings = findZeroCrossings(buffer.getChannelData(0), {
      unit: "seconds",
      sampleRate: buffer.sampleRate,
    });
    expect(crossings.length).toBeGreaterThan(0);
  });

  it("only analyzes the channel supplied by the caller", () => {
    const left = Float32Array.from([1, 1]);
    const right = Float32Array.from([1, -1]);

    expect(findZeroCrossings(left, { unit: "seconds", sampleRate: 1 })).toEqual([]);
    expect(findZeroCrossings(right, { unit: "seconds", sampleRate: 1 })).toEqual([0.5]);
  });

  it("can return sample and second positions together", () => {
    const channel = Float32Array.from([1, -3]);

    expect(findZeroCrossings(channel, { unit: "both", sampleRate: 2 })).toEqual({
      samples: [0],
      seconds: [0.125],
    });
  });

  it("findWaveCycles returns cycles", () => {
    const buffer = new MockAudioBuffer([1, -1, 1, -1]);
    const cycles = findWaveCycles(buffer as any);
    expect(Array.isArray(cycles)).toBe(true);
  });

  it("findWaveCycles pairs cycles by direction", () => {
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
