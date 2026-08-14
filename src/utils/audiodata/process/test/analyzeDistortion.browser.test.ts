import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { preProcessAudioBuffer, DEFAULT_PRE_PROCESS_OPTIONS } from '@/nodes/preprocessor/Preprocessor';

describe('Analyze distortion in init_sample.webm', () => {
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
    const response = await fetch('/src/storage/assets/init_sample.webm');
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  function analyzeDistortion(buffer: AudioBuffer, label: string) {
    const stats = {
      peak: 0,
      rms: 0,
      crestFactor: 0,
      zeroCrossings: 0,
      clippedSamples: 0,
      nearClipping: 0,
      suddenJumps: 0, // Count of sudden amplitude changes
      maxJump: 0,
    };

    // Accumulate RMS across all channels
    let totalSquareSum = 0;
    let totalSamples = 0;

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      let squareSum = 0;
      let prevSample = 0;
      let prevSign = 0;

      for (let i = 0; i < data.length; i++) {
        const sample = data[i];
        const absSample = Math.abs(sample);
        
        // Peak detection
        if (absSample > stats.peak) stats.peak = absSample;
        
        // RMS calculation
        squareSum += sample * sample;
        
        // Clipping detection
        if (absSample >= 0.99) stats.clippedSamples++;
        if (absSample >= 0.95) stats.nearClipping++;
        
        // Zero crossing detection
        const currentSign = sample > 0 ? 1 : sample < 0 ? -1 : 0;
        if (i > 0 && prevSign !== 0 && currentSign !== 0 && prevSign !== currentSign) {
          stats.zeroCrossings++;
        }
        prevSign = currentSign;
        
        // Sudden jump detection (potential source of clicks/distortion)
        if (i > 0) {
          const jump = Math.abs(sample - prevSample);
          if (jump > stats.maxJump) stats.maxJump = jump;
          // A jump > 0.5 in one sample is suspicious
          if (jump > 0.5) stats.suddenJumps++;
        }
        prevSample = sample;
      }

      // Accumulate channel's contribution to total RMS
      totalSquareSum += squareSum;
      totalSamples += data.length;
    }

    // Calculate RMS and crest factor once, using all channels
    if (totalSamples > 0) {
      stats.rms = Math.sqrt(totalSquareSum / totalSamples);
      stats.crestFactor = stats.rms > 0 ? stats.peak / stats.rms : 0;
    }

    console.log(`\n${label}:`);
    console.log(`  Peak: ${stats.peak.toFixed(4)}`);
    console.log(`  RMS: ${stats.rms.toFixed(4)}`);
    console.log(`  Crest Factor: ${stats.crestFactor.toFixed(2)} (higher = more dynamic)`);
    console.log(`  Clipped samples: ${stats.clippedSamples}`);
    console.log(`  Near clipping (>0.95): ${stats.nearClipping}`);
    console.log(`  Zero crossings: ${stats.zeroCrossings}`);
    console.log(`  Sudden jumps (>0.5): ${stats.suddenJumps}`);
    console.log(`  Max sample jump: ${stats.maxJump.toFixed(4)}`);
    
    return stats;
  }

  it('should analyze distortion through the full pipeline', async () => {
    const original = await loadInitSample();
    
    console.log('\n=== DISTORTION ANALYSIS ===');
    const originalStats = analyzeDistortion(original, 'Original');
    
    // Process through full pipeline
    const processed = await preProcessAudioBuffer(audioContext, original);
    const processedStats = analyzeDistortion(processed.audiobuffer, 'After Full Pipeline');
    
    // Calculate changes
    console.log('\n=== CHANGES ===');
    console.log(`  Peak change: ${((processedStats.peak / originalStats.peak - 1) * 100).toFixed(1)}%`);
    console.log(`  RMS change: ${((processedStats.rms / originalStats.rms - 1) * 100).toFixed(1)}%`);
    console.log(`  Crest factor change: ${(processedStats.crestFactor - originalStats.crestFactor).toFixed(2)}`);
    console.log(`  Sudden jumps change: ${processedStats.suddenJumps - originalStats.suddenJumps}`);
    console.log(`  Max jump change: ${(processedStats.maxJump - originalStats.maxJump).toFixed(4)}`);
    
    // Check if sudden jumps increased significantly (source of clicks/pops)
    if (processedStats.suddenJumps > originalStats.suddenJumps * 2) {
      console.log('\n⚠️ WARNING: Significant increase in sudden jumps - may cause clicks/pops');
    }
    
    // Check if crest factor decreased too much (over-compression)
    if (processedStats.crestFactor < originalStats.crestFactor * 0.5) {
      console.log('\n⚠️ WARNING: Crest factor reduced by >50% - possible over-compression');
    }
  });

  it('should test without compression', async () => {
    const original = await loadInitSample();
    
    console.log('\n=== WITHOUT COMPRESSION ===');
    analyzeDistortion(original, 'Original');
    
    const withoutCompression = await preProcessAudioBuffer(audioContext, original, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: false }
    });
    analyzeDistortion(withoutCompression.audiobuffer, 'Without Compression');
  });

  it('should test with different compression settings', async () => {
    const original = await loadInitSample();
    
    console.log('\n=== COMPRESSION VARIATIONS ===');
    
    // Gentle compression
    const gentle = await preProcessAudioBuffer(audioContext, original, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: true, threshold: 0.5, ratio: 2, makeupGain: 1.1 }
    });
    analyzeDistortion(gentle.audiobuffer, 'Gentle (threshold=0.5, ratio=2, gain=1.1)');
    
    // Current settings
    const current = await preProcessAudioBuffer(audioContext, original, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: true, threshold: 0.3, ratio: 4, makeupGain: 1.5 }
    });
    analyzeDistortion(current.audiobuffer, 'Current (threshold=0.3, ratio=4, gain=1.5)');
    
    // Aggressive compression
    const aggressive = await preProcessAudioBuffer(audioContext, original, {
      ...DEFAULT_PRE_PROCESS_OPTIONS,
      compress: { enabled: true, threshold: 0.2, ratio: 8, makeupGain: 1.8 }
    });
    analyzeDistortion(aggressive.audiobuffer, 'Aggressive (threshold=0.2, ratio=8, gain=1.8)');
  });

  it('should analyze frequency content changes', async () => {
    const original = await loadInitSample();
    const processed = await preProcessAudioBuffer(audioContext, original);
    
    console.log('\n=== FREQUENCY ANALYSIS ===');
    
    // Simple frequency analysis using FFT
    const analyzeFrequencies = (buffer: AudioBuffer, label: string) => {
      const data = buffer.getChannelData(0);
      const fftSize = 2048;
      const fft = new Float32Array(fftSize);
      
      // Take a sample from the middle of the buffer
      const startIdx = Math.floor(data.length / 2 - fftSize / 2);
      for (let i = 0; i < fftSize && startIdx + i < data.length; i++) {
        fft[i] = data[startIdx + i];
      }
      
      // Very simple "FFT" - just measure energy in different bands
      let lowEnergy = 0;   // < 200 Hz
      let midEnergy = 0;   // 200-2000 Hz  
      let highEnergy = 0;  // > 2000 Hz
      
      for (let i = 0; i < fftSize; i++) {
        const freq = (i / fftSize) * (buffer.sampleRate / 2);
        const energy = Math.abs(fft[i]);
        
        if (freq < 200) lowEnergy += energy;
        else if (freq < 2000) midEnergy += energy;
        else highEnergy += energy;
      }
      
      const total = lowEnergy + midEnergy + highEnergy;
      console.log(`${label}:`);
      console.log(`  Low (<200Hz): ${((lowEnergy/total)*100).toFixed(1)}%`);
      console.log(`  Mid (200-2000Hz): ${((midEnergy/total)*100).toFixed(1)}%`);
      console.log(`  High (>2000Hz): ${((highEnergy/total)*100).toFixed(1)}%`);
    };
    
    analyzeFrequencies(original, 'Original');
    analyzeFrequencies(processed.audiobuffer, 'Processed');
  });
});
