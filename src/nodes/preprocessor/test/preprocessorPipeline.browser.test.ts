import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  preProcessAudioBuffer,
  DEFAULT_PRE_PROCESS_OPTIONS,
} from '../Preprocessor';

describe('Preprocessor pipeline with quiet recordings', () => {
  let audioContext: AudioContext;

  beforeEach(() => {
    audioContext = new AudioContext();
  });

  afterEach(async () => {
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }
    audioContext = null as any;
  });

  // Helper function to analyze amplitude
  function analyzeAmplitude(buffer: AudioBuffer, label: string) {
    let peak = 0;
    let rms = 0;
    let samples = 0;

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      let squareSum = 0;

      for (let i = 0; i < data.length; i++) {
        const absSample = Math.abs(data[i]);
        if (absSample > peak) peak = absSample;
        squareSum += data[i] * data[i];
      }
      samples += data.length;
      rms += squareSum;
    }

    rms = Math.sqrt(rms / samples);

    console.log(`${label}:`);
    console.log(`  Peak: ${peak.toFixed(4)}`);
    console.log(`  RMS: ${rms.toFixed(4)}`);

    return { peak, rms };
  }

  // Create a quiet recording simulation
  function createQuietRecording(peakLevel = 0.05): AudioBuffer {
    const sampleRate = audioContext.sampleRate;
    const duration = 2; // 2 seconds
    const length = sampleRate * duration;
    const buffer = audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // Simulate a quiet recording with some dynamics
    for (let i = 0; i < length; i++) {
      // Base tone (very quiet)
      let sample =
        peakLevel * 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);

      // Add occasional "louder" parts (still quiet overall)
      if (i > length * 0.3 && i < length * 0.4) {
        sample = peakLevel * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      }

      // Add some noise
      sample += (Math.random() - 0.5) * 0.001;

      data[i] = sample;
    }

    return buffer;
  }

  it('should analyze quiet recording through full pipeline', async () => {
    const quietBuffer = createQuietRecording(0.05);

    console.log('\n=== Quiet Recording Pipeline Test ===');
    const originalStats = analyzeAmplitude(quietBuffer, 'Original');

    // Test with default options (compression enabled, normalization enabled)
    const processed = await preProcessAudioBuffer(audioContext, quietBuffer);
    const processedStats = analyzeAmplitude(
      processed.audiobuffer,
      'After Full Pipeline'
    );

    console.log(
      `Gain applied: ${(processedStats.peak / originalStats.peak).toFixed(2)}x`
    );

    // The peak should be close to 0.98 (our target)
    expect(processedStats.peak).toBeGreaterThan(0.9);
    expect(processedStats.peak).toBeLessThanOrEqual(0.98);
  });

  it('should compare with/without compression', async () => {
    const quietBuffer = createQuietRecording(0.03);

    console.log('\n=== Compression Impact on Quiet Audio ===');
    analyzeAmplitude(quietBuffer, 'Original');

    // Without compression
    const withoutCompression = await preProcessAudioBuffer(
      audioContext,
      quietBuffer,
      {
        ...DEFAULT_PRE_PROCESS_OPTIONS,
        compress: { enabled: false },
      }
    );
    const withoutCompStats = analyzeAmplitude(
      withoutCompression.audiobuffer,
      'Without Compression'
    );

    // With compression
    const withCompression = await preProcessAudioBuffer(
      audioContext,
      quietBuffer,
      DEFAULT_PRE_PROCESS_OPTIONS
    );
    const withCompStats = analyzeAmplitude(
      withCompression.audiobuffer,
      'With Compression'
    );

    // Both should reach similar peaks (close to 0.98)
    console.log('\nPeak comparison:');
    console.log(`  Without compression: ${withoutCompStats.peak.toFixed(4)}`);
    console.log(`  With compression: ${withCompStats.peak.toFixed(4)}`);
  });

  it('should test each stage separately', async () => {
    const quietBuffer = createQuietRecording(0.04);

    console.log('\n=== Stage-by-Stage Analysis ===');
    const original = analyzeAmplitude(quietBuffer, '1. Original');

    // Just compression
    const { compressAudioBuffer } = await import(
      '../../../utils/audiodata/process/compressAudioBuffer'
    );
    const compressed = compressAudioBuffer(
      audioContext,
      quietBuffer,
      0.3,
      4,
      1.5
    );
    const compressedStats = analyzeAmplitude(
      compressed,
      '2. After Compression Only'
    );

    // Just normalization
    const { normalizeAudioBuffer } = await import(
      '../../../utils/audiodata/process/normalizeAudioBuffer'
    );
    const normalized = normalizeAudioBuffer(audioContext, quietBuffer, 0.98);
    const normalizedStats = analyzeAmplitude(
      normalized,
      '3. After Normalization Only'
    );

    // Compression then normalization
    const compThenNorm = normalizeAudioBuffer(audioContext, compressed, 0.98);
    const bothStats = analyzeAmplitude(
      compThenNorm,
      '4. Compression + Normalization'
    );

    console.log('\nSummary:');
    console.log(`  Original peak: ${original.peak.toFixed(4)}`);
    console.log(`  After compression: ${compressedStats.peak.toFixed(4)}`);
    console.log(
      `  After normalization only: ${normalizedStats.peak.toFixed(4)}`
    );
    console.log(`  After both: ${bothStats.peak.toFixed(4)}`);

    // Normalization alone should reach 0.98
    expect(normalizedStats.peak).toBeCloseTo(0.98, 2);
    // Compression + normalization should also reach 0.98
    expect(bothStats.peak).toBeCloseTo(0.98, 2);
  });

  it('should check if trim silence affects peaks', async () => {
    // Create buffer with silence at start/end
    const sampleRate = audioContext.sampleRate;
    const buffer = audioContext.createBuffer(1, sampleRate * 2, sampleRate);
    const data = buffer.getChannelData(0);

    // Silence for first 0.5 seconds
    // Quiet audio in middle
    // Silence for last 0.5 seconds
    for (let i = sampleRate * 0.5; i < sampleRate * 1.5; i++) {
      data[i] = 0.03 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    console.log('\n=== Trim Silence Impact ===');
    analyzeAmplitude(buffer, 'Original with silence');

    // Process with trim silence enabled
    const withTrim = await preProcessAudioBuffer(audioContext, buffer, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false }, // Disable compression to isolate trim effect
      trimSilence: { enabled: true, threshold: 0.01 },
    });
    analyzeAmplitude(withTrim.audiobuffer, 'After trim + normalization');

    // Process without trim
    const withoutTrim = await preProcessAudioBuffer(audioContext, buffer, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false },
      trimSilence: { enabled: false },
    });
    analyzeAmplitude(
      withoutTrim.audiobuffer,
      'Without trim, just normalization'
    );
  });
});
