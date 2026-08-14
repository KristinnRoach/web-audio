import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldCompress } from '../shouldCompress';
import {
  preProcessAudioBuffer,
  DEFAULT_PRE_PROCESS_OPTIONS,
} from '../../../../nodes/preprocessor/Preprocessor';

describe('Test compression decision for init_sample', () => {
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

  async function loadInitSample(): Promise<AudioBuffer> {
    const url = new URL(
      '../../../../storage/assets/init_sample.webm',
      import.meta.url
    );
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  function calculateCrestFactor(buffer: AudioBuffer): number {
    let peak = 0;
    let sumSquares = 0;
    let sampleCount = 0;

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const sample = Math.abs(data[i]);
        if (sample > peak) peak = sample;
        sumSquares += data[i] * data[i];
        sampleCount++;
      }
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    return peak > 0 ? peak / rms : 0;
  }

  it('should analyze crest factor at each stage', async () => {
    const original = await loadInitSample();

    console.log('\n=== CREST FACTOR ANALYSIS ===');

    // Original
    const originalCrest = calculateCrestFactor(original);
    console.log(`1. Original: ${originalCrest.toFixed(2)}`);

    // After each preprocessing step
    console.log('\n=== Step by step ===');

    // Just trim silence
    const trimmed = await preProcessAudioBuffer(audioContext, original, {
      normalize: { enabled: false },
      compress: { enabled: false },
      trimSilence: { enabled: true, threshold: 0.01 },
      fadeInOutMs: 5,
      tune: { detectPitch: false, autotune: false },
      hpf: undefined,
      getZeroCrossings: false,
    });
    const trimmedCrest = calculateCrestFactor(trimmed.audiobuffer);
    console.log(`2. After trim silence: ${trimmedCrest.toFixed(2)}`);

    // Trim + HPF
    const withHPF = await preProcessAudioBuffer(audioContext, original, {
      normalize: { enabled: false },
      compress: { enabled: false },
      trimSilence: { enabled: true, threshold: 0.01 },
      fadeInOutMs: 5,
      tune: { detectPitch: false, autotune: false },
      hpf: { cutoff: 80 },
      getZeroCrossings: false,
    });
    const hpfCrest = calculateCrestFactor(withHPF.audiobuffer);
    console.log(`3. After trim + HPF: ${hpfCrest.toFixed(2)}`);

    // Trim + HPF + Normalize
    const normalized = await preProcessAudioBuffer(audioContext, original, {
      normalize: { enabled: true, maxAmplitudePeak: 0.98 },
      compress: { enabled: false },
      trimSilence: { enabled: true, threshold: 0.01 },
      fadeInOutMs: 5,
      tune: { detectPitch: false, autotune: false },
      hpf: { cutoff: 80 },
      getZeroCrossings: false,
    });
    const normalizedCrest = calculateCrestFactor(normalized.audiobuffer);
    console.log(
      `4. After trim + HPF + normalize: ${normalizedCrest.toFixed(2)}`
    );

    // Now test what shouldCompress says about the normalized buffer
    console.log('\n=== shouldCompress() decision on normalized buffer ===');
    const decision = shouldCompress(normalized.audiobuffer);
    console.log('Decision:', decision);

    // Test thresholds
    console.log('\n=== Crest factor thresholds ===');
    console.log('< 5.5: Skip compression (already compressed/borderline)');
    console.log('5.5–7: Gentle compression');
    console.log('> 7: Normal compression');
    console.log(
      `\nNormalized buffer crest factor: ${decision.crestFactor.toFixed(2)}`
    );
    console.log(`Decision: ${decision.shouldCompress ? 'COMPRESS' : 'SKIP'}`);
    if (decision.suggestedSettings) {
      console.log('Suggested settings:', decision.suggestedSettings);
    }
  });

  it('should test different crest factor thresholds', async () => {
    const original = await loadInitSample();

    // Process to normalized state
    const normalized = await preProcessAudioBuffer(audioContext, original, {
      normalize: { enabled: true, maxAmplitudePeak: 0.98 },
      compress: { enabled: false },
      trimSilence: { enabled: true, threshold: 0.01 },
      fadeInOutMs: 5,
      tune: { detectPitch: false, autotune: false },
      hpf: { cutoff: 80 },
      getZeroCrossings: false,
    });

    const crestFactor = calculateCrestFactor(normalized.audiobuffer);

    console.log('\n=== Testing different thresholds ===');
    console.log(`Actual crest factor: ${crestFactor.toFixed(2)}`);

    // Test with different threshold values
    const thresholds = [3.5, 4.0, 4.5, 5.0, 5.5, 6.0];

    for (const threshold of thresholds) {
      const wouldCompress = crestFactor > threshold;
      console.log(
        `Threshold ${threshold}: ${wouldCompress ? 'COMPRESS' : 'SKIP'}`
      );
    }

    console.log('\n=== Recommendation ===');
    if (crestFactor < 5) {
      console.log('This sample should NOT be compressed (crest factor < 5)');
    } else if (crestFactor < 6) {
      console.log('This sample is borderline - gentle compression at most');
    } else {
      console.log('This sample could benefit from compression');
    }
  });

  it('should analyze why init_sample sounds distorted', async () => {
    const original = await loadInitSample();

    console.log('\n=== FULL PIPELINE TEST ===');

    // Full pipeline with compression
    const withCompression = await preProcessAudioBuffer(
      audioContext,
      original,
      DEFAULT_PRE_PROCESS_OPTIONS
    );

    // Full pipeline without compression
    const withoutCompression = await preProcessAudioBuffer(
      audioContext,
      original,
      {
        ...DEFAULT_PRE_PROCESS_OPTIONS,
        compress: { enabled: false },
      }
    );

    const withCrest = calculateCrestFactor(withCompression.audiobuffer);
    const withoutCrest = calculateCrestFactor(withoutCompression.audiobuffer);

    console.log(`With compression: crest factor = ${withCrest.toFixed(2)}`);
    console.log(
      `Without compression: crest factor = ${withoutCrest.toFixed(2)}`
    );
    console.log(`Difference: ${(withoutCrest - withCrest).toFixed(2)}`);

    if (withCrest < withoutCrest * 0.8) {
      console.log(
        '\n⚠️ Compression is reducing dynamics by >20% - this may cause audible artifacts'
      );
    }
  });
});
