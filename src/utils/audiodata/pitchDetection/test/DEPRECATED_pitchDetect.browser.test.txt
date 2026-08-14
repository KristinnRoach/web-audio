// pitch-detection.browser.test.ts
import { describe, it, expect } from 'vitest';
import { detectSinglePitchAC } from '../autocorrelateSingle';
import { fetchInitSampleAsAudioBuffer } from '../../../storage/assets/asset-utils';
import { findClosestNote } from '../../music-theory';

describe('Pitch Detection - Real Audio Files', () => {
  it('detects pitch from default init sample audio file', async () => {
    const audioBuffer = await fetchInitSampleAsAudioBuffer();
    const result = await detectSinglePitchAC(audioBuffer);

    console.log('Real audio result:', {
      frequency: result.frequency,
      confidence: result.confidence,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
    });

    const note = findClosestNote(result.frequency);

    console.log('findClosestNote results: ', { ...note });

    // Basic sanity checks for real audio
    expect(result.frequency).toBeGreaterThan(50); // Above bass range
    expect(result.frequency).toBeLessThan(2000); // Below high frequencies
    expect(result.confidence).toBeGreaterThan(0); // Some confidence
    expect(audioBuffer.duration).toBeGreaterThan(0);
  }, 10000); // 10s timeout for file loading
});
