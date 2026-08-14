import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeAudioBuffer } from '../normalizeAudioBuffer';

describe('normalizeAudioBuffer amplitude analysis', () => {
  let audioContext: AudioContext;

  beforeEach(() => {
    // Create AudioContext for each test
    audioContext = new AudioContext();
  });

  afterEach(async () => {
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }
    audioContext = null as any;
  });

  // Helper function to analyze amplitude statistics
  function analyzeAmplitude(buffer: AudioBuffer) {
    const stats = {
      peak: 0,
      rms: 0,
      average: 0,
      samples: 0,
    };

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      let sum = 0;
      let squareSum = 0;

      for (let i = 0; i < data.length; i++) {
        const sample = Math.abs(data[i]);
        sum += sample;
        squareSum += data[i] * data[i];
        if (sample > stats.peak) {
          stats.peak = sample;
        }
      }

      stats.samples += data.length;
      stats.average += sum;
      stats.rms += squareSum;
    }

    // Calculate final statistics
    stats.average = stats.average / stats.samples;
    stats.rms = Math.sqrt(stats.rms / stats.samples);

    return stats;
  }

  // Helper to create test audio buffer with specific amplitude
  function createTestBuffer(
    maxAmplitude: number = 0.5,
    durationSec: number = 1
  ): AudioBuffer {
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * durationSec;
    const buffer = audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // Create a simple sine wave with the specified amplitude
    const frequency = 440; // A4
    for (let i = 0; i < length; i++) {
      data[i] =
        maxAmplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    }

    return buffer;
  }

  it('should normalize quiet audio to target peak (0.9 by default)', () => {
    // Create a quiet buffer with peak at 0.1
    const quietBuffer = createTestBuffer(0.1);

    // Analyze before normalization
    const statsBefore = analyzeAmplitude(quietBuffer);
    console.log('Before normalization:', statsBefore);

    // Normalize
    const normalizedBuffer = normalizeAudioBuffer(audioContext, quietBuffer);

    // Analyze after normalization
    const statsAfter = analyzeAmplitude(normalizedBuffer);
    console.log('After normalization:', statsAfter);

    // The peak should be very close to 0.9 (default target)
    expect(statsAfter.peak).toBeCloseTo(0.9, 5);

    // The gain factor should be 0.9 / 0.1 = 9
    const expectedGain = 0.9 / 0.1;
    expect(statsAfter.peak / statsBefore.peak).toBeCloseTo(expectedGain, 5);
    expect(statsAfter.rms / statsBefore.rms).toBeCloseTo(expectedGain, 5);
  });

  it('should normalize loud audio to target peak', () => {
    // Create a loud buffer with peak at 0.95
    const loudBuffer = createTestBuffer(0.95);

    // Analyze before normalization
    const statsBefore = analyzeAmplitude(loudBuffer);

    // Normalize
    const normalizedBuffer = normalizeAudioBuffer(audioContext, loudBuffer);

    // Analyze after normalization
    const statsAfter = analyzeAmplitude(normalizedBuffer);

    // The peak should be reduced to 0.9
    expect(statsAfter.peak).toBeCloseTo(0.9, 5);

    // The gain factor should be 0.9 / 0.95 ≈ 0.947
    const expectedGain = 0.9 / 0.95;
    expect(statsAfter.peak / statsBefore.peak).toBeCloseTo(expectedGain, 5);
  });

  it('should handle custom target peak values', () => {
    const buffer = createTestBuffer(0.3);
    const targetPeak = 0.7;

    const statsBefore = analyzeAmplitude(buffer);
    const normalizedBuffer = normalizeAudioBuffer(
      audioContext,
      buffer,
      targetPeak
    );
    const statsAfter = analyzeAmplitude(normalizedBuffer);

    // Should normalize to custom target
    expect(statsAfter.peak).toBeCloseTo(targetPeak, 5);

    // Verify gain calculation
    const expectedGain = targetPeak / 0.3;
    expect(statsAfter.peak / statsBefore.peak).toBeCloseTo(expectedGain, 5);
  });

  it('should handle very quiet audio (simulating recorded audio)', () => {
    // Simulate very quiet recorded audio with peak at 0.05
    const veryQuietBuffer = createTestBuffer(0.05);

    const statsBefore = analyzeAmplitude(veryQuietBuffer);
    const normalizedBuffer = normalizeAudioBuffer(
      audioContext,
      veryQuietBuffer
    );
    const statsAfter = analyzeAmplitude(normalizedBuffer);

    console.log('Very quiet audio test:');
    console.log('  Before - Peak:', statsBefore.peak, 'RMS:', statsBefore.rms);
    console.log('  After - Peak:', statsAfter.peak, 'RMS:', statsAfter.rms);
    console.log('  Gain applied:', statsAfter.peak / statsBefore.peak);

    // Should boost to 0.9
    expect(statsAfter.peak).toBeCloseTo(0.9, 5);

    // This is a 18x gain boost (0.9 / 0.05 = 18)
    const expectedGain = 18;
    expect(statsAfter.peak / statsBefore.peak).toBeCloseTo(expectedGain, 5);
  });

  it('should handle silence without errors', () => {
    // Create a silent buffer
    const silentBuffer = audioContext.createBuffer(1, 44100, 44100);
    // All samples are already 0 by default

    const statsBefore = analyzeAmplitude(silentBuffer);
    const normalizedBuffer = normalizeAudioBuffer(audioContext, silentBuffer);
    const statsAfter = analyzeAmplitude(normalizedBuffer);

    // Should remain silent (no division by zero)
    expect(statsAfter.peak).toBe(0);
    expect(statsAfter.rms).toBe(0);
  });

  it('should analyze realistic dynamic range compression', () => {
    // Create a buffer with varying amplitudes (simulating dynamic audio)
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * 2; // 2 seconds
    const buffer = audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // First half: quiet (0.1 amplitude)
    // Second half: loud (0.4 amplitude)
    for (let i = 0; i < length / 2; i++) {
      data[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }
    for (let i = length / 2; i < length; i++) {
      data[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const statsBefore = analyzeAmplitude(buffer);
    const normalizedBuffer = normalizeAudioBuffer(audioContext, buffer);
    const statsAfter = analyzeAmplitude(normalizedBuffer);

    console.log('Dynamic audio test:');
    console.log('  Before - Peak:', statsBefore.peak, 'RMS:', statsBefore.rms);
    console.log('  After - Peak:', statsAfter.peak, 'RMS:', statsAfter.rms);
    console.log('  Gain applied:', statsAfter.peak / statsBefore.peak);

    // Peak should be normalized to 0.9
    expect(statsAfter.peak).toBeCloseTo(0.9, 5);

    // The gain should be based on the loudest part (0.4)
    const expectedGain = 0.9 / 0.4;
    expect(statsAfter.peak / statsBefore.peak).toBeCloseTo(expectedGain, 5);
  });
});
