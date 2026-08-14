/**
 * Analyzes an audio buffer to determine if it needs compression
 * Returns compression settings or null if compression should be skipped
 */
export function shouldCompress(buffer: AudioBuffer): {
  shouldCompress: boolean;
  crestFactor: number;
  suggestedSettings?: {
    threshold: number;
    ratio: number;
    makeupGain: number;
  };
} {
  // Calculate peak and RMS
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

  // Guard against empty buffer (division by zero)
  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const crestFactor = rms > 0 ? peak / rms : 0;

  // Decision logic based on crest factor
  // Adjusted thresholds to be more conservative
  if (crestFactor < 5.5) {
    // Already compressed/mastered or borderline - skip compression
    // This includes most professionally mastered audio
    return {
      shouldCompress: false,
      crestFactor,
    };
  } else if (crestFactor < 7) {
    // Moderate dynamics - gentle compression
    return {
      shouldCompress: true,
      crestFactor,
      suggestedSettings: {
        threshold: 0.5,
        ratio: 2,
        makeupGain: 1.0, // No makeup gain needed after normalization
      },
    };
  } else {
    // Very dynamic (likely raw recording) - normal compression
    return {
      shouldCompress: true,
      crestFactor,
      suggestedSettings: {
        threshold: 0.3,
        ratio: 4,
        makeupGain: 1.0, // No makeup gain needed after normalization
      },
    };
  }
}

/**
 * Even simpler version - just check if audio needs compression
 */
export function needsCompression(buffer: AudioBuffer): boolean {
  let peak = 0;
  let sumSquares = 0;
  let sampleCount = 0;

  // Quick sample - just check first 10% of buffer for speed
  const samplesToCheck = Math.min(buffer.length * 0.1, 44100); // Max 1 second

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    // Clamp to actual data length to prevent out-of-bounds access
    const samplesInChannel = Math.min(samplesToCheck, data.length);
    for (let i = 0; i < samplesInChannel; i++) {
      const sample = Math.abs(data[i]);
      if (sample > peak) peak = sample;
      sumSquares += data[i] * data[i];
      sampleCount++;
    }
  }

  // Guard against empty buffer and division by zero
  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const crestFactor = rms > 0 ? peak / rms : 0;

  // Simple decision: compress if crest factor > 5.5 (more conservative)
  return crestFactor > 5.5;
}
