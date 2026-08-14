import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldCompress, needsCompression } from '../shouldCompress';

describe('shouldCompress edge cases', () => {
  let audioContext: AudioContext | null = null;

  beforeEach(() => {
    // Create a mock AudioContext for testing
    audioContext = {
      sampleRate: 44100,
      createBuffer: function(numberOfChannels: number, length: number, sampleRate: number) {
        const channels: Float32Array[] = [];
        for (let i = 0; i < numberOfChannels; i++) {
          channels.push(new Float32Array(length));
        }
        return {
          numberOfChannels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: (channel: number) => channels[channel],
        } as AudioBuffer;
      }
    } as unknown as AudioContext;
  });

  afterEach(() => {
    audioContext = null;
  });

  describe('shouldCompress', () => {
    it('should handle empty buffer without crashing', () => {
      const buffer = audioContext!.createBuffer(1, 0, 44100);
      const result = shouldCompress(buffer);
      
      expect(result.crestFactor).toBe(0);
      expect(result.shouldCompress).toBe(false);
    });

    it('should handle silent buffer (all zeros)', () => {
      const buffer = audioContext!.createBuffer(2, 1000, 44100);
      // Buffer is already filled with zeros by default
      
      const result = shouldCompress(buffer);
      
      expect(result.crestFactor).toBe(0);
      expect(result.shouldCompress).toBe(false);
    });

    it('should handle buffer with DC offset', () => {
      const buffer = audioContext!.createBuffer(1, 1000, 44100);
      const data = buffer.getChannelData(0);
      
      // Fill with constant value (DC signal)
      for (let i = 0; i < data.length; i++) {
        data[i] = 0.5;
      }
      
      const result = shouldCompress(buffer);
      
      // For DC signal, peak = RMS, so crest factor = 1
      expect(result.crestFactor).toBeCloseTo(1.0, 5);
      expect(result.shouldCompress).toBe(false); // crest factor < 5.5
    });

    it('should handle very small buffer', () => {
      const buffer = audioContext!.createBuffer(1, 1, 44100);
      const data = buffer.getChannelData(0);
      data[0] = 0.7;
      
      const result = shouldCompress(buffer);
      
      expect(result.crestFactor).toBeCloseTo(1.0, 5); // Single sample: peak = RMS
      expect(result.shouldCompress).toBe(false);
    });

    it('should correctly identify dynamic audio needing compression', () => {
      const buffer = audioContext!.createBuffer(1, 1000, 44100);
      const data = buffer.getChannelData(0);
      
      // Create dynamic signal (high crest factor)
      for (let i = 0; i < data.length; i++) {
        // Mostly quiet with occasional peaks
        data[i] = i % 100 === 0 ? 0.9 : 0.05;
      }
      
      const result = shouldCompress(buffer);
      
      expect(result.crestFactor).toBeGreaterThan(5.5);
      expect(result.shouldCompress).toBe(true);
      expect(result.suggestedSettings).toBeDefined();
    });
  });

  describe('needsCompression', () => {
    it('should handle empty buffer without crashing', () => {
      const buffer = audioContext!.createBuffer(1, 0, 44100);
      const result = needsCompression(buffer);
      
      expect(result).toBe(false);
    });

    it('should not read out of bounds on small buffers', () => {
      // Create a buffer smaller than the default sample size
      const buffer = audioContext!.createBuffer(2, 100, 44100);
      const data0 = buffer.getChannelData(0);
      const data1 = buffer.getChannelData(1);
      
      // Fill with test data
      for (let i = 0; i < 100; i++) {
        data0[i] = Math.sin(2 * Math.PI * i / 100) * 0.5;
        data1[i] = Math.sin(2 * Math.PI * i / 100) * 0.3;
      }
      
      // This should not throw or produce NaN
      const result = needsCompression(buffer);
      
      expect(typeof result).toBe('boolean');
      expect(result).not.toBeNaN();
    });

    it('should handle buffer where samplesToCheck exceeds data length', () => {
      // The function tries to check 10% of buffer.length or 44100 samples
      // Create a buffer where 10% would be larger than actual channel data
      const buffer = audioContext!.createBuffer(1, 500, 44100);
      const data = buffer.getChannelData(0);
      
      // Fill with dynamic signal
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 50 === 0 ? 0.8 : 0.1;
      }
      
      // Should not crash or read out of bounds
      const result = needsCompression(buffer);
      
      expect(typeof result).toBe('boolean');
    });

    it('should handle multi-channel buffer correctly', () => {
      const buffer = audioContext!.createBuffer(2, 1000, 44100);
      
      // Fill both channels with dynamic data
      for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          // Create dynamic signal in both channels
          data[i] = i % 100 === 0 ? 0.9 : 0.01;
        }
      }
      
      const result = needsCompression(buffer);
      
      // Should detect that the audio is dynamic
      expect(result).toBe(true);
    });

    it('should handle buffer with NaN or Infinity values gracefully', () => {
      const buffer = audioContext!.createBuffer(1, 100, 44100);
      const data = buffer.getChannelData(0);
      
      // Add some problematic values
      data[0] = NaN;
      data[1] = Infinity;
      data[2] = -Infinity;
      for (let i = 3; i < 100; i++) {
        data[i] = 0.1;
      }
      
      // Should not crash, though result may not be meaningful
      const result = needsCompression(buffer);
      
      // The result will be based on how NaN/Infinity propagate through math
      expect(typeof result).toBe('boolean');
    });
  });
});
