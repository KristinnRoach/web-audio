import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import { normalizeAudioBuffer } from '../normalizeAudioBuffer';

describe('Normalization experiments for better volume', () => {
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

  function analyzeAmplitude(buffer: AudioBuffer) {
    const stats = {
      peak: 0,
      rms: 0,
      samples: 0,
      // Percentile analysis
      samples95percentile: 0,
      samplesAbove01: 0,
      samplesAbove05: 0,
    };

    const allSamples: number[] = [];

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      let squareSum = 0;

      for (let i = 0; i < data.length; i++) {
        const sample = Math.abs(data[i]);
        allSamples.push(sample);
        squareSum += data[i] * data[i];

        if (sample > stats.peak) {
          stats.peak = sample;
        }
        if (sample > 0.1) stats.samplesAbove01++;
        if (sample > 0.5) stats.samplesAbove05++;
      }

      stats.samples += data.length;
      stats.rms += squareSum;
    }

    // Calculate RMS
    stats.rms = Math.sqrt(stats.rms / stats.samples);

    // Calculate 95th percentile
    allSamples.sort((a, b) => a - b);
    const index95 = Math.floor(allSamples.length * 0.95);
    stats.samples95percentile = allSamples[index95];

    return stats;
  }

  // Simulate very quiet recorded audio (typical microphone recording)
  function createRealisticRecordedBuffer(): AudioBuffer {
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * 2; // 2 seconds
    const buffer = audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // Simulate typical recorded audio with:
    // - Low overall amplitude (0.02 average)
    // - Some noise floor
    // - Occasional peaks
    for (let i = 0; i < length; i++) {
      // Base signal (very quiet voice-like pattern)
      const baseSignal =
        0.02 * Math.sin((2 * Math.PI * 200 * i) / sampleRate) +
        0.01 * Math.sin((2 * Math.PI * 400 * i) / sampleRate);

      // Add some noise
      const noise = (Math.random() - 0.5) * 0.002;

      // Occasional louder parts (simulate consonants/transients)
      const transient = i % 8820 < 100 ? Math.random() * 0.03 : 0;

      data[i] = baseSignal + noise + transient;
    }

    return buffer;
  }

  it('should compare different target peaks for recorded audio', () => {
    const recordedBuffer = createRealisticRecordedBuffer();
    const statsOriginal = analyzeAmplitude(recordedBuffer);

    console.log('\n=== Original Recorded Audio ===');
    console.log('Peak:', statsOriginal.peak);
    console.log('RMS:', statsOriginal.rms);
    console.log('95th percentile:', statsOriginal.samples95percentile);
    console.log(
      'Samples > 0.1:',
      statsOriginal.samplesAbove01,
      '/',
      statsOriginal.samples
    );
    console.log(
      'Samples > 0.5:',
      statsOriginal.samplesAbove05,
      '/',
      statsOriginal.samples
    );

    // Test different target peaks
    const targets = [0.7, 0.8, 0.9, 0.95, 0.99];

    targets.forEach((target) => {
      const normalized = normalizeAudioBuffer(
        audioContext,
        recordedBuffer,
        target
      );
      const stats = analyzeAmplitude(normalized);
      const gain = stats.peak / statsOriginal.peak;

      console.log(`\n=== Target Peak: ${target} ===`);
      console.log('Applied Gain:', gain.toFixed(2) + 'x');
      console.log('New Peak:', stats.peak);
      console.log('New RMS:', stats.rms);
      console.log('New 95th percentile:', stats.samples95percentile);
      console.log('Samples > 0.1:', stats.samplesAbove01, '/', stats.samples);
      console.log('Samples > 0.5:', stats.samplesAbove05, '/', stats.samples);
      console.log('RMS to Peak ratio:', (stats.rms / stats.peak).toFixed(3));
    });
  });

  it('should test extreme normalization (target = 1.0)', () => {
    const recordedBuffer = createRealisticRecordedBuffer();
    const statsOriginal = analyzeAmplitude(recordedBuffer);

    // Try maximum normalization (peak = 1.0)
    // Note: This might cause clipping in real use, but let's test it
    const maxNormalized = normalizeAudioBuffer(
      audioContext,
      recordedBuffer,
      1.0
    );
    const statsMax = analyzeAmplitude(maxNormalized);

    console.log('\n=== Maximum Normalization Test (target = 1.0) ===');
    console.log('Original Peak:', statsOriginal.peak);
    console.log('Normalized Peak:', statsMax.peak);
    console.log(
      'Gain Applied:',
      (statsMax.peak / statsOriginal.peak).toFixed(2) + 'x'
    );
    console.log('Original RMS:', statsOriginal.rms);
    console.log('Normalized RMS:', statsMax.rms);
    console.log(
      'Perceived Loudness Increase (RMS ratio):',
      (statsMax.rms / statsOriginal.rms).toFixed(2) + 'x'
    );

    // Peak should be exactly 1.0
    expect(statsMax.peak).toBeCloseTo(1.0, 5);
  });

  it('should analyze if current 0.9 target is sufficient', () => {
    // Create multiple test cases simulating different recording scenarios
    const scenarios = [
      { name: 'Very Quiet (0.01 peak)', peak: 0.01 },
      { name: 'Quiet (0.03 peak)', peak: 0.03 },
      { name: 'Moderate (0.1 peak)', peak: 0.1 },
      { name: 'Normal (0.3 peak)', peak: 0.3 },
    ];

    console.log('\n=== Analysis: Is 0.9 target sufficient? ===');

    scenarios.forEach((scenario) => {
      const buffer = audioContext.createBuffer(1, 44100, 44100);
      const data = buffer.getChannelData(0);

      // Create test signal with specified peak
      for (let i = 0; i < data.length; i++) {
        data[i] = scenario.peak * Math.sin((2 * Math.PI * 440 * i) / 44100);
      }

      const normalized = normalizeAudioBuffer(audioContext, buffer, 0.9);
      const statsNorm = analyzeAmplitude(normalized);
      const gain = 0.9 / scenario.peak;

      console.log(`\n${scenario.name}:`);
      console.log(`  Required gain: ${gain.toFixed(1)}x`);
      console.log(`  Result Peak: ${statsNorm.peak.toFixed(3)}`);
      console.log(`  Result RMS: ${statsNorm.rms.toFixed(3)}`);

      // Check if we might be hitting gain limits
      if (gain > 50) {
        console.log(
          '  ⚠️ WARNING: Very high gain required - might amplify noise significantly'
        );
      }
      if (gain > 100) {
        console.log(
          '  ⚠️ CRITICAL: Extreme gain - audio quality will likely suffer'
        );
      }
    });
  });
});
