import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  preProcessAudioBuffer,
  DEFAULT_PRE_PROCESS_OPTIONS,
} from '../Preprocessor';

describe('Debug >1.0 peak issue', () => {
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

  function analyzeBuffer(buffer: AudioBuffer, label: string) {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }
    console.log(`${label}: peak = ${peak.toFixed(6)}`);
    return peak;
  }

  it('should track where peaks exceed 1.0', async () => {
    // Create quiet buffer with known peak
    const buffer = audioContext.createBuffer(1, 48000, 48000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.03 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }

    console.log('\n=== Step-by-step processing ===');
    analyzeBuffer(buffer, '1. Original');

    // Test each step individually
    const { normalizeAudioBuffer } = await import(
      '../../../utils/audiodata/process/normalizeAudioBuffer'
    );
    const { compressAudioBuffer } = await import(
      '../../../utils/audiodata/process/compressAudioBuffer'
    );
    const { detectThresholdCrossing } = await import(
      '../../../utils/audiodata/process/detectSilence'
    );
    const { trimAudioBuffer } = await import(
      '../../../utils/audiodata/process/trimBuffer'
    );

    // Step 1: Normalize
    const normalized = normalizeAudioBuffer(audioContext, buffer, 0.98);
    const peakAfterNorm = analyzeBuffer(
      normalized,
      '2. After normalize to 0.98'
    );
    expect(peakAfterNorm).toBeCloseTo(0.98, 4);

    // Step 2: Compress
    const compressed = compressAudioBuffer(
      audioContext,
      normalized,
      0.3,
      4,
      1.5
    );
    const peakAfterComp = analyzeBuffer(compressed, '3. After compress');

    // Step 3: Detect silence thresholds
    const { start, end } = detectThresholdCrossing(compressed, 0.01);
    console.log(
      `4. Silence detection: start=${start}, end=${end}, buffer.length=${compressed.length}`
    );

    // Step 4: Trim
    const trimmed = trimAudioBuffer(audioContext, compressed, start, end, 5);
    const peakAfterTrim = analyzeBuffer(trimmed, '5. After trim');

    // Also test autotune since it might be the culprit
    console.log('\n=== Testing if autotune causes issues ===');
    const fullProcess = await preProcessAudioBuffer(audioContext, buffer, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false }, // Disable compression to isolate issue
      tune: { detectPitch: true, autotune: true, targetMidiNote: 60 },
    });
    analyzeBuffer(fullProcess.audiobuffer, 'With autotune');

    const noAutotune = await preProcessAudioBuffer(audioContext, buffer, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false },
      tune: { detectPitch: false, autotune: false },
    });
    analyzeBuffer(noAutotune.audiobuffer, 'Without autotune');
  });

  it('should test high-pass filter impact', async () => {
    const buffer = audioContext.createBuffer(1, 48000, 48000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.03 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }

    console.log('\n=== Testing HPF impact ===');

    const withHPF = await preProcessAudioBuffer(audioContext, buffer, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false },
      tune: { detectPitch: false, autotune: false },
      hpf: { cutoff: 80 },
    });
    analyzeBuffer(withHPF.audiobuffer, 'With HPF');

    const withoutHPF = await preProcessAudioBuffer(audioContext, buffer, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false },
      tune: { detectPitch: false, autotune: false },
      hpf: undefined,
    });
    analyzeBuffer(withoutHPF.audiobuffer, 'Without HPF');
  });
});
