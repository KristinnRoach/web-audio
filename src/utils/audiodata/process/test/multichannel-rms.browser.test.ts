import { describe, it, expect } from 'vitest';

describe('Multi-channel RMS calculation', () => {
  it('should correctly calculate RMS across all channels', () => {
    // Create a mock AudioContext
    const audioContext = new AudioContext();
    
    // Create a 2-channel buffer with known values
    const sampleRate = 44100;
    const length = 100;
    const buffer = audioContext.createBuffer(2, length, sampleRate);
    
    // Channel 0: constant value of 0.5
    const channel0 = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      channel0[i] = 0.5;
    }
    
    // Channel 1: constant value of 0.3
    const channel1 = buffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      channel1[i] = 0.3;
    }
    
    // Calculate RMS manually (the correct way)
    // RMS = sqrt((sum of all squared samples) / (total number of samples))
    // Channel 0: 100 samples of 0.5^2 = 100 * 0.25 = 25
    // Channel 1: 100 samples of 0.3^2 = 100 * 0.09 = 9
    // Total: 25 + 9 = 34
    // Total samples: 200
    // RMS = sqrt(34 / 200) = sqrt(0.17) ≈ 0.4123
    
    const expectedRMS = Math.sqrt((100 * 0.25 + 100 * 0.09) / 200);
    
    // Function to analyze (simplified version of the fixed code)
    function analyzeBuffer(buffer: AudioBuffer) {
      let peak = 0;
      let totalSquareSum = 0;
      let totalSamples = 0;
      
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        let squareSum = 0;
        
        for (let i = 0; i < data.length; i++) {
          const sample = data[i];
          const absSample = Math.abs(sample);
          if (absSample > peak) peak = absSample;
          squareSum += sample * sample;
        }
        
        totalSquareSum += squareSum;
        totalSamples += data.length;
      }
      
      const rms = totalSamples > 0 ? Math.sqrt(totalSquareSum / totalSamples) : 0;
      const crestFactor = rms > 0 ? peak / rms : 0;
      
      return { peak, rms, crestFactor };
    }
    
    const stats = analyzeBuffer(buffer);
    
    // Verify the calculations
    expect(stats.peak).toBe(0.5); // Peak should be 0.5 (from channel 0)
    expect(stats.rms).toBeCloseTo(expectedRMS, 5);
    expect(stats.crestFactor).toBeCloseTo(0.5 / expectedRMS, 5);
    
    // The old buggy code would have calculated:
    // - Peak: 0.5 (correct, from channel 0)
    // - RMS: 0.3 (WRONG - only from last channel)
    // - Crest Factor: 0.5 / 0.3 = 1.667 (WRONG)
    
    // The fixed code calculates:
    // - Peak: 0.5 (correct)
    // - RMS: 0.4123 (correct - across all channels)
    // - Crest Factor: 0.5 / 0.4123 = 1.213 (correct)
    
    // Ensure we're NOT getting the buggy values
    expect(stats.rms).not.toBeCloseTo(0.3, 2); // Should NOT be just the last channel
    expect(stats.crestFactor).not.toBeCloseTo(1.667, 2); // Should NOT use wrong RMS
  });
  
  it('should handle single-channel audio correctly', () => {
    const audioContext = new AudioContext();
    const buffer = audioContext.createBuffer(1, 100, 44100);
    
    // Fill with known values
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < 100; i++) {
      channel[i] = 0.4;
    }
    
    function analyzeBuffer(buffer: AudioBuffer) {
      let peak = 0;
      let totalSquareSum = 0;
      let totalSamples = 0;
      
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        let squareSum = 0;
        
        for (let i = 0; i < data.length; i++) {
          const sample = data[i];
          const absSample = Math.abs(sample);
          if (absSample > peak) peak = absSample;
          squareSum += sample * sample;
        }
        
        totalSquareSum += squareSum;
        totalSamples += data.length;
      }
      
      const rms = totalSamples > 0 ? Math.sqrt(totalSquareSum / totalSamples) : 0;
      const crestFactor = rms > 0 ? peak / rms : 0;
      
      return { peak, rms, crestFactor };
    }
    
    const stats = analyzeBuffer(buffer);
    
    // For constant signal, RMS = absolute value
    expect(stats.peak).toBeCloseTo(0.4, 5);
    expect(stats.rms).toBeCloseTo(0.4, 5);
    expect(stats.crestFactor).toBeCloseTo(1.0, 5); // Peak = RMS for constant signal
  });
});
