// compress-utils.ts

/**
 *  Hard clipping / limiting to output range
 *  Default ±1.0 outputRange
 *
 *  Note: No validation since optimized for real time use
 *        We assume that input.length === output.length
 */
export const hardLimit = (
  input: Float32Array,
  output: Float32Array,
  outputRange = { min: -1, max: 1 }
) => {
  const { min, max } = outputRange;

  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    output[i] = Math.max(min, Math.min(max, x));
  }
};

/**
 *  Basic attenuation compressor for arrays
 *
 *  Note: No validation since optimized for real time use
 *        We assume that input.length === output.length
 */
export const compress = (
  input: Float32Array,
  output: Float32Array,
  threshold = 0.75,
  ratio = 4.0,
  limiter = { enabled: true, outputRange: { min: -1, max: 1 } }
) => {
  const { min, max } = limiter.outputRange;

  for (let i = 0; i < input.length; i++) {
    let x = input[i];
    if (Math.abs(x) > threshold) {
      x = Math.sign(x) * (threshold + (Math.abs(x) - threshold) / ratio);
    }

    if (limiter.enabled) {
      x = Math.max(min, Math.min(max, x));
    }
    output[i] = x;
  }
};

export const softClipSingleSample = (
  sample: number,
  threshold = 0.8,
  max = 0.9
) => {
  if (Math.abs(sample) < threshold) return sample;

  const softClipped =
    Math.sign(sample) *
    (threshold + (1 - Math.exp(-Math.abs(sample) + threshold)));

  // Hard limit to prevent exceeding max
  return Math.max(-max, Math.min(max, softClipped));
};

// export const softClipSingleSample = (sample: number, max = 0.9) => {
//   return Math.sign(sample) * max * Math.tanh(sample / max);
// };

export const cheapSoftClipSingleSample = (sample: number, max = 0.9) => {
  const a = Math.abs(sample);
  if (a <= max) return sample;
  // Rational approximation: bounded and fast
  const x = a / max;
  const compressed = x / (1 + x);
  return Math.sign(sample) * max * compressed;
};

/**
 *  Basic attenuation compressor for single sample
 *  Note: No validation since optimized for real time use
 */
export const compressSingleSample = (
  input: number,
  threshold = 0.75,
  ratio = 4.0,
  limiter = { enabled: true, type: 'soft', outputRange: { min: -1, max: 1 } }
): number => {
  const { min, max } = limiter.outputRange;

  let x = input;
  if (Math.abs(x) > threshold) {
    x = Math.sign(x) * (threshold + (Math.abs(x) - threshold) / ratio);
  }

  if (limiter.enabled) {
    if (limiter.type === 'soft') {
      x = cheapSoftClipSingleSample(x, Math.abs(max));
    } else if (limiter.type === 'hard') {
      x = Math.max(min, Math.min(max, x));
    }
  }

  return x;
};
