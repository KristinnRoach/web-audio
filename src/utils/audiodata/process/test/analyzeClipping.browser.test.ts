import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeAudioBuffer } from '../normalizeAudioBuffer';
import { compressAudioBuffer } from '../compressAudioBuffer';

describe('Analyze clipping with init_sample.webm', () => {
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

  // Comprehensive amplitude analysis
  function analyzeAmplitude(buffer: AudioBuffer, label: string) {
    const stats = {
      label,
      peak: 0,
      rms: 0,
      average: 0,
      samples: 0,
      clippedSamples: 0,
      nearClippingSamples: 0, // samples > 0.95
      samplesAbove90: 0,
      samplesAbove80: 0,
      minValue: 1,
      maxValue: -1,
    };

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      let sum = 0;
      let squareSum = 0;

      for (let i = 0; i < data.length; i++) {
        const sample = data[i];
        const absSample = Math.abs(sample);

        sum += absSample;
        squareSum += sample * sample;

        // Track min/max actual values
        if (sample < stats.minValue) stats.minValue = sample;
        if (sample > stats.maxValue) stats.maxValue = sample;

        // Track peak
        if (absSample > stats.peak) {
          stats.peak = absSample;
        }

        // Count problematic samples
        if (absSample >= 0.99) stats.clippedSamples++;
        if (absSample >= 0.95) stats.nearClippingSamples++;
        if (absSample >= 0.9) stats.samplesAbove90++;
        if (absSample >= 0.8) stats.samplesAbove80++;
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

  // Helper to load the actual webm file
  async function loadInitSample(): Promise<AudioBuffer> {
    // Fetch the webm file
    const response = await fetch('/src/storage/assets/init_sample.webm');
    const arrayBuffer = await response.arrayBuffer();

    // Decode the audio
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  it('should analyze the init_sample.webm file characteristics', async () => {
    const buffer = await loadInitSample();
    const stats = analyzeAmplitude(buffer, 'Original');

    console.log('\n=== Original Sample Analysis ===');
    console.log('Duration:', buffer.duration.toFixed(2), 'seconds');
    console.log('Sample Rate:', buffer.sampleRate, 'Hz');
    console.log('Channels:', buffer.numberOfChannels);
    console.log('Peak:', stats.peak.toFixed(4));
    console.log('RMS:', stats.rms.toFixed(4));
    console.log('Average:', stats.average.toFixed(4));
    console.log('Min value:', stats.minValue.toFixed(4));
    console.log('Max value:', stats.maxValue.toFixed(4));
    console.log(
      'Clipped samples (≥0.99):',
      stats.clippedSamples,
      '/',
      stats.samples
    );
    console.log(
      'Near clipping (≥0.95):',
      stats.nearClippingSamples,
      '/',
      stats.samples
    );
    console.log('Samples ≥0.90:', stats.samplesAbove90, '/', stats.samples);
    console.log('Samples ≥0.80:', stats.samplesAbove80, '/', stats.samples);

    // Store for comparison
    expect(stats.peak).toBeCloseTo(1.0, 3);
  });

  it('should analyze compression -> normalization pipeline', async () => {
    const buffer = await loadInitSample();

    // Analyze original
    const statsOriginal = analyzeAmplitude(buffer, 'Original');
    console.log('\n=== Processing Pipeline Analysis ===');
    console.log(
      'Original Peak:',
      statsOriginal.peak.toFixed(4),
      'RMS:',
      statsOriginal.rms.toFixed(4)
    );

    // Step 1: Compression (with default settings)
    const compressed = compressAudioBuffer(
      audioContext,
      buffer,
      0.3, // threshold
      4, // ratio
      1.5 // makeup gain
    );
    const statsCompressed = analyzeAmplitude(compressed, 'After Compression');
    console.log('\nAfter Compression:');
    console.log(
      '  Peak:',
      statsCompressed.peak.toFixed(4),
      'RMS:',
      statsCompressed.rms.toFixed(4)
    );
    console.log('  Clipped samples:', statsCompressed.clippedSamples);
    console.log('  Near clipping:', statsCompressed.nearClippingSamples);

    // Step 2: Normalization
    const normalized = normalizeAudioBuffer(audioContext, compressed, 0.98);
    const statsNormalized = analyzeAmplitude(normalized, 'After Normalization');
    console.log('\nAfter Normalization to 0.98:');
    console.log(
      '  Peak:',
      statsNormalized.peak.toFixed(4),
      'RMS:',
      statsNormalized.rms.toFixed(4)
    );
    console.log('  Clipped samples:', statsNormalized.clippedSamples);
    console.log('  Near clipping:', statsNormalized.nearClippingSamples);

    // Check where clipping is introduced
    if (statsCompressed.clippedSamples > 0) {
      console.log('\n⚠️ Clipping introduced during COMPRESSION');
    }
    if (statsNormalized.clippedSamples > statsCompressed.clippedSamples) {
      console.log('\n⚠️ Additional clipping introduced during NORMALIZATION');
    }
  });

  it('should test different compression settings to find non-clipping parameters', async () => {
    const buffer = await loadInitSample();
    const statsOriginal = analyzeAmplitude(buffer, 'Original');

    console.log('\n=== Testing Different Compression Settings ===');
    console.log('Original Peak:', statsOriginal.peak.toFixed(4));

    // Test different makeup gain values
    const makeupGains = [1.0, 1.2, 1.5, 1.8, 2.0];
    const thresholds = [0.2, 0.3, 0.4];

    for (const threshold of thresholds) {
      for (const gain of makeupGains) {
        const compressed = compressAudioBuffer(
          audioContext,
          buffer,
          threshold,
          4, // ratio
          gain // makeup gain
        );

        const stats = analyzeAmplitude(
          compressed,
          `Threshold: ${threshold}, Gain: ${gain}`
        );

        if (stats.clippedSamples === 0) {
          console.log(
            `✅ No clipping with threshold=${threshold}, gain=${gain}, peak=${stats.peak.toFixed(4)}`
          );
        } else {
          console.log(
            `❌ Clipping with threshold=${threshold}, gain=${gain}, clipped=${stats.clippedSamples}`
          );
        }
      }
    }
  });

  it('should analyze if the safe gain calculation is working', async () => {
    const buffer = await loadInitSample();

    console.log('\n=== Safe Gain Calculation Analysis ===');

    // Manually calculate what the safe gain should be
    let inputPeak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > inputPeak) inputPeak = abs;
      }
    }

    console.log('Input Peak:', inputPeak.toFixed(4));

    // Calculate theoretical compressed peak
    const threshold = 0.3;
    const ratio = 4;
    const theoreticalCompressedPeak =
      inputPeak <= threshold
        ? inputPeak
        : threshold + (inputPeak - threshold) / ratio;

    console.log(
      'Theoretical compressed peak (before makeup gain):',
      theoreticalCompressedPeak.toFixed(4)
    );

    // Maximum safe gain
    const maxSafeGain = 0.99 / theoreticalCompressedPeak;
    console.log('Maximum safe makeup gain:', maxSafeGain.toFixed(4));

    // Test with different requested gains
    const requestedGains = [1.0, 1.5, 2.0, maxSafeGain, maxSafeGain + 0.1];

    for (const requestedGain of requestedGains) {
      const compressed = compressAudioBuffer(
        audioContext,
        buffer,
        threshold,
        ratio,
        requestedGain
      );

      const stats = analyzeAmplitude(compressed, `Gain: ${requestedGain}`);
      const actualGain = stats.peak / theoreticalCompressedPeak;

      console.log(`\nRequested gain: ${requestedGain.toFixed(4)}`);
      console.log(`  Actual gain applied: ${actualGain.toFixed(4)}`);
      console.log(`  Result peak: ${stats.peak.toFixed(4)}`);
      console.log(`  Clipped samples: ${stats.clippedSamples}`);

      if (requestedGain <= maxSafeGain && stats.clippedSamples > 0) {
        console.log('  ⚠️ UNEXPECTED: Clipping occurred despite safe gain!');
      }
    }
  });

  it('should visualize sample distribution', async () => {
    const buffer = await loadInitSample();

    console.log('\n=== Sample Distribution Analysis ===');

    // Create histogram bins
    const bins = 10;
    const histogram = new Array(bins).fill(0);
    let totalSamples = 0;

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        const binIndex = Math.min(Math.floor(abs * bins), bins - 1);
        histogram[binIndex]++;
        totalSamples++;
      }
    }

    console.log('Distribution of sample amplitudes:');
    for (let i = 0; i < bins; i++) {
      const rangeStart = (i / bins).toFixed(2);
      const rangeEnd = ((i + 1) / bins).toFixed(2);
      const percentage = ((histogram[i] / totalSamples) * 100).toFixed(2);
      const bar = '█'.repeat(Math.round(parseFloat(percentage) / 2));
      console.log(
        `${rangeStart}-${rangeEnd}: ${bar} ${percentage}% (${histogram[i]} samples)`
      );
    }
  });
});
