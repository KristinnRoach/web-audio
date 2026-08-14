/**
 * Simple dynamic range compressor that makes quiet parts louder
 * without increasing the peak level (prevents clipping)
 * Automatically adjusts makeup gain based on input level to prevent clipping
 */
export function compressAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  threshold = 0.5, // Level above which compression starts
  ratio = 4, // Compression ratio (4:1 means 4dB input = 1dB output above threshold)
  targetMakeupGain = 1 // Desired makeup gain (will be reduced if input is already loud)
): AudioBuffer {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;

  // First, analyze the input to determine safe makeup gain
  let inputPeak = 0;
  for (let ch = 0; ch < numChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > inputPeak) inputPeak = abs;
    }
  }

  // Calculate safe makeup gain that won't cause clipping
  // If the input is already loud, reduce or skip makeup gain
  let safeGain = targetMakeupGain;
  if (inputPeak > 0) {
    // After compression, the peak will be at most: threshold + (inputPeak - threshold) / ratio
    const compressedPeak =
      inputPeak <= threshold
        ? inputPeak
        : threshold + (inputPeak - threshold) / ratio;
    // Maximum safe gain is 0.95 / compressedPeak (using 0.95 instead of 0.99 for safety margin)
    const maxSafeGain = 0.95 / compressedPeak;
    safeGain = Math.min(targetMakeupGain, maxSafeGain);

    // Additional check: if input is already very loud, be more conservative
    if (inputPeak > 0.9) {
      safeGain = Math.min(safeGain, 1.2); // Limit gain to 1.2x for already-loud audio
    }
  }

  // Create output buffer
  const compressed = ctx.createBuffer(numChannels, length, sampleRate);

  // Process each channel
  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const output = compressed.getChannelData(ch);

    // Simple compressor implementation
    for (let i = 0; i < length; i++) {
      const sample = input[i];
      const absSample = Math.abs(sample);

      let processedSample: number;

      if (absSample <= threshold) {
        // Below threshold: no compression, just apply makeup gain
        processedSample = sample * safeGain;
      } else {
        // Above threshold: apply compression
        const excess = absSample - threshold;
        const compressedExcess = excess / ratio;
        const compressedLevel = threshold + compressedExcess;

        // Maintain the sign and apply makeup gain
        const sign = sample < 0 ? -1 : 1;
        processedSample = sign * compressedLevel * safeGain;
      }

      // Hard limit to prevent clipping (safety measure)
      output[i] = Math.max(-0.99, Math.min(0.99, processedSample));
    }
  }

  return compressed;
}

/**
 * More sophisticated compressor with smoother response
 * Uses RMS (Root Mean Square) detection for more natural compression
 */
export function compressAudioBufferRMS(
  ctx: AudioContext,
  buffer: AudioBuffer,
  options: {
    threshold?: number; // RMS level where compression starts (0-1)
    ratio?: number; // Compression ratio
    attack?: number; // Attack time in seconds
    release?: number; // Release time in seconds
    makeupGain?: number; // Post-compression gain
    lookahead?: number; // Lookahead time in seconds
  } = {}
): AudioBuffer {
  const {
    threshold = 0.2,
    ratio = 3,
    attack = 0.003, // 3ms attack
    release = 0.1, // 100ms release
    makeupGain = 2,
    lookahead = 0.005, // 5ms lookahead
  } = options;

  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;

  // Convert time constants to samples
  const attackSamples = Math.max(1, Math.floor(attack * sampleRate));
  const releaseSamples = Math.max(1, Math.floor(release * sampleRate));
  const lookaheadSamples = Math.max(0, Math.floor(lookahead * sampleRate));
  const rmsWindowSize = Math.max(1, Math.floor(0.01 * sampleRate)); // 10ms RMS window

  // Create output buffer
  const compressed = ctx.createBuffer(numChannels, length, sampleRate);

  // Process each channel
  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const output = compressed.getChannelData(ch);

    // Calculate RMS envelope
    const rmsEnvelope = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      let count = 0;

      // Calculate RMS over window
      const start = Math.max(0, i - Math.floor(rmsWindowSize / 2));
      const end = Math.min(length, i + Math.floor(rmsWindowSize / 2));

      for (let j = start; j < end; j++) {
        sum += input[j] * input[j];
        count++;
      }

      rmsEnvelope[i] = Math.sqrt(sum / count);
    }

    // Apply compression with envelope following
    let currentGainReduction = 1;

    for (let i = 0; i < length; i++) {
      // Look ahead for peak detection
      const lookaheadIndex = Math.min(i + lookaheadSamples, length - 1);
      const rmsLevel = rmsEnvelope[lookaheadIndex];

      // Calculate target gain reduction
      let targetGainReduction = 1;
      if (rmsLevel > threshold) {
        const excess = rmsLevel - threshold;
        const compressedExcess = excess / ratio;
        const compressedLevel = threshold + compressedExcess;
        targetGainReduction = compressedLevel / rmsLevel;
      }

      // Smooth gain changes (attack/release)
      if (targetGainReduction < currentGainReduction) {
        // Attack (compressor engaging)
        const attackRate = 1 / attackSamples;
        currentGainReduction = Math.max(
          targetGainReduction,
          currentGainReduction - attackRate
        );
      } else {
        // Release (compressor releasing)
        const releaseRate = 1 / releaseSamples;
        currentGainReduction = Math.min(1, currentGainReduction + releaseRate);
      }

      // Apply compression and makeup gain
      const processedSample = input[i] * currentGainReduction * makeupGain;

      // Soft limiting to prevent harsh clipping
      output[i] = softLimit(processedSample);
    }
  }

  return compressed;
}

/**
 * Soft limiting function - smoother than hard clipping
 * Uses tanh (hyperbolic tangent) for smooth saturation
 */
function softLimit(sample: number, threshold = 0.95): number {
  if (Math.abs(sample) <= threshold) {
    return sample;
  }

  // Soft saturation using tanh
  const sign = sample < 0 ? -1 : 1;
  const abs = Math.abs(sample);

  // Scale and apply tanh, then scale back
  const scaled = (abs - threshold) / (1 - threshold);
  const limited = threshold + (1 - threshold) * Math.tanh(scaled);

  return sign * Math.min(0.99, limited);
}
