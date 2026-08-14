// utils/audiodata/generateWaveform.ts

/**
 * Utility functions for generating custom PeriodicWaves for Web Audio API oscillators.
 * These complement the built-in sine, square, sawtooth, and triangle waves.
 */

/** Custom Audiolib waveform */
const CUSTOM_WAVEFORMS = [
  'pulse',
  'bandlimited-sawtooth',
  'supersaw',
  'warm-pad',
  'metallic',
  'formant',
  'white-noise',
  'pink-noise',
  'brown-noise',
  'colored-noise',
  'random-harmonic',
  'custom-function',
] as const;

export type CustomLibWaveform = (typeof CUSTOM_WAVEFORMS)[number];

/** Union type of all supported waveforms */
export type SupportedWaveform =
  | 'sine'
  | 'sawtooth'
  | 'square'
  | 'triangle'
  | CustomLibWaveform;

/** All supported oscillator waveforms */
export const SUPPORTED_WAVEFORMS: readonly SupportedWaveform[] = [
  // Default web audio waveforms
  'sine',
  'sawtooth',
  'square',
  'triangle',

  // Custom audiolib waveforms
  ...CUSTOM_WAVEFORMS,
] as const;

/** Typeguard for Audiolib's custom waveforms */
export function isCustomLibWaveform(
  waveform: string
): waveform is CustomLibWaveform {
  return CUSTOM_WAVEFORMS.includes(waveform as CustomLibWaveform);
}
/**
 * Generic options interface that can be used with any CustomLibWaveform type
 */
export interface WaveformOptions {
  // Common options
  harmonics?: number;
  seed?: number;

  // Pulse wave
  dutyCycle?: number;

  // Bandlimited sawtooth
  rolloff?: number;

  // Supersaw
  voices?: number;
  detune?: number;

  // Warm pad
  brightness?: number;

  // Metallic wave
  inharmonicity?: number;

  // Formant wave
  formantFreqs?: number[];
  formantBandwidths?: number[];
  fundamentalFreq?: number;

  // Colored noise
  slope?: number;

  // Random harmonic
  chaos?: number;
  harmonicDensity?: number;

  // Custom function wave
  waveFunction?: (phase: number) => number;
}

/**
 * Creates any custom waveform based on the type string
 * @param audioContext - The Web Audio API context
 * @param type - The type of waveform to create
 * @param options - Configuration options for the waveform
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createWave(
  audioContext: AudioContext,
  type: CustomLibWaveform,
  options: WaveformOptions = {}
): PeriodicWave {
  switch (type) {
    case 'pulse':
      return createPulseWave(audioContext, {
        dutyCycle: options.dutyCycle,
        harmonics: options.harmonics,
      });
    case 'bandlimited-sawtooth':
      return createBandlimitedSawtooth(audioContext, {
        harmonics: options.harmonics,
        rolloff: options.rolloff,
      });
    case 'supersaw':
      return createSupersaw(audioContext, {
        voices: options.voices,
        detune: options.detune,
        harmonics: options.harmonics,
      });
    case 'warm-pad':
      return createWarmPad(audioContext, {
        brightness: options.brightness,
        harmonics: options.harmonics,
      });
    case 'metallic':
      return createMetallicWave(audioContext, {
        inharmonicity: options.inharmonicity,
        harmonics: options.harmonics,
      });
    case 'formant':
      return createFormantWave(audioContext, {
        formantFreqs: options.formantFreqs,
        formantBandwidths: options.formantBandwidths,
        fundamentalFreq: options.fundamentalFreq,
        harmonics: options.harmonics,
      });
    case 'white-noise':
      return createWhiteNoise(audioContext, {
        harmonics: options.harmonics,
        seed: options.seed,
      });
    case 'pink-noise':
      return createPinkNoise(audioContext, {
        harmonics: options.harmonics,
        seed: options.seed,
      });
    case 'brown-noise':
      return createBrownNoise(audioContext, {
        harmonics: options.harmonics,
        seed: options.seed,
      });
    case 'colored-noise':
      return createColoredNoise(audioContext, {
        slope: options.slope,
        harmonics: options.harmonics,
        seed: options.seed,
      });
    case 'random-harmonic':
      return createRandomHarmonicWave(audioContext, {
        chaos: options.chaos,
        harmonicDensity: options.harmonicDensity,
        harmonics: options.harmonics,
        seed: options.seed,
      });
    case 'custom-function':
      return createWaveFromFunction(
        audioContext,
        options.waveFunction || ((phase) => Math.sin(phase)),
        {
          harmonics: options.harmonics,
        }
      );
    default:
      throw new Error(`Invalid waveform type: ${type}`);
  }
}

/**
 * Creates a pulse wave with variable duty cycle
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.dutyCycle - The duty cycle (0-1), where 0.5 is a square wave (default: 0.5)
 * @param options.harmonics - Number of harmonics to generate (default: 32)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createPulseWave(
  audioContext: AudioContext,
  options: {
    dutyCycle?: number;
    harmonics?: number;
  } = {}
): PeriodicWave {
  const { dutyCycle = 0.5, harmonics = 32 } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  // Pulse wave is generated using Fourier series
  // a_n = (2/π) * sin(n*π*dutyCycle) / n
  for (let n = 1; n <= harmonics; n++) {
    real[n] = 0; // Pulse wave has no cosine components
    imag[n] = ((2 / Math.PI) * Math.sin(n * Math.PI * dutyCycle)) / n;
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a bandlimited sawtooth wave with controllable harmonics
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.harmonics - Number of harmonics to include (default: 32)
 * @param options.rolloff - Harmonic rolloff factor (default: 1, higher values = more rolloff)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createBandlimitedSawtooth(
  audioContext: AudioContext,
  options: {
    harmonics?: number;
    rolloff?: number;
  } = {}
): PeriodicWave {
  const { harmonics = 32, rolloff = 1 } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  for (let n = 1; n <= harmonics; n++) {
    real[n] = 0;
    // Sawtooth: amplitude = 1/n with rolloff
    imag[n] = (1 / n) * Math.pow(n, -rolloff + 1);
    if (n % 2 === 0) imag[n] *= -1; // Alternate sign for even harmonics
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a supersaw wave (multiple detuned sawtooths)
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.voices - Number of voices to stack (default: 7)
 * @param options.detune - Maximum detune amount in cents (default: 25)
 * @param options.harmonics - Number of harmonics per voice (default: 16)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createSupersaw(
  audioContext: AudioContext,
  options: {
    voices?: number;
    detune?: number;
    harmonics?: number;
  } = {}
): PeriodicWave {
  const { voices = 7, detune = 25, harmonics = 16 } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  for (let voice = 0; voice < voices; voice++) {
    // Calculate detune for this voice
    const voiceDetune =
      voice === 0
        ? 0
        : (voice % 2 === 1 ? 1 : -1) *
          Math.ceil(voice / 2) *
          (detune / Math.ceil(voices / 2));

    const detuneRatio = Math.pow(2, voiceDetune / 1200);

    for (let n = 1; n <= harmonics; n++) {
      const harmonicFreq = n * detuneRatio;
      if (harmonicFreq <= harmonics) {
        const amplitude = (1 / voices) * (1 / n);
        imag[Math.floor(harmonicFreq)] += amplitude * (n % 2 === 1 ? 1 : -1);
      }
    }
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a warm pad wave with filtered harmonics
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.brightness - Controls high frequency content (0-1, default: 0.3)
 * @param options.harmonics - Number of harmonics to generate (default: 64)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createWarmPad(
  audioContext: AudioContext,
  options: {
    brightness?: number;
    harmonics?: number;
  } = {}
): PeriodicWave {
  const { brightness = 0.3, harmonics = 64 } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  for (let n = 1; n <= harmonics; n++) {
    // Combine odd harmonics (like sawtooth) with exponential rolloff
    const amplitude = (1 / n) * Math.exp(-n * (1 - brightness) * 0.1);

    if (n % 2 === 1) {
      // Odd harmonics only
      imag[n] = amplitude;
    }

    // Add some even harmonics for warmth
    if (n % 2 === 0 && n <= harmonics / 2) {
      imag[n] = amplitude * 0.3;
    }
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a metallic/bell-like wave with inharmonic partials
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.inharmonicity - Amount of inharmonic content (0-1, default: 0.2)
 * @param options.harmonics - Number of harmonics to generate (default: 32)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createMetallicWave(
  audioContext: AudioContext,
  options: {
    inharmonicity?: number;
    harmonics?: number;
  } = {}
): PeriodicWave {
  const { inharmonicity = 0.2, harmonics = 32 } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  for (let n = 1; n <= harmonics; n++) {
    // Create inharmonic frequencies: f_n = f_0 * sqrt(1 + B*n^2)
    const inharmonicRatio = Math.sqrt(1 + inharmonicity * n * n);
    const targetBin = Math.round(n * inharmonicRatio);

    if (targetBin <= harmonics) {
      const amplitude = 1 / (n * n); // Bell-like amplitude decay

      // Mix sine and cosine for richer timbre
      real[targetBin] += amplitude * 0.3;
      imag[targetBin] += amplitude * 0.7;
    }
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a formant wave that mimics vocal characteristics
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.formantFreqs - Array of formant frequencies in Hz (default: [800, 1200, 2600])
 * @param options.formantBandwidths - Array of formant bandwidths in Hz (default: [80, 120, 260])
 * @param options.fundamentalFreq - Fundamental frequency in Hz for calculation (default: 440)
 * @param options.harmonics - Number of harmonics to generate (default: 64)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createFormantWave(
  audioContext: AudioContext,
  options: {
    formantFreqs?: number[];
    formantBandwidths?: number[];
    fundamentalFreq?: number;
    harmonics?: number;
  } = {}
): PeriodicWave {
  const {
    formantFreqs = [800, 1200, 2600],
    formantBandwidths = [80, 120, 260],
    fundamentalFreq = 440,
    harmonics = 64,
  } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  for (let n = 1; n <= harmonics; n++) {
    const harmonicFreq = n * fundamentalFreq;
    let amplitude = 1 / n; // Start with sawtooth-like spectrum

    // Apply formant filtering
    for (let f = 0; f < formantFreqs.length; f++) {
      const formantFreq = formantFreqs[f];
      const bandwidth = formantBandwidths[f] || 100;

      // Simple formant filter approximation
      const distance = Math.abs(harmonicFreq - formantFreq);
      const formantGain = 1 / (1 + Math.pow(distance / bandwidth, 2));
      amplitude *= 1 + formantGain * 2;
    }

    imag[n] = amplitude * (n % 2 === 1 ? 1 : -1);
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a wave table from an arbitrary function
 * @param audioContext - The Web Audio API context
 * @param waveFunction - Function that takes phase (0-2π) and returns amplitude (-1 to 1)
 * @param options - Configuration options
 * @param options.harmonics - Number of harmonics to analyze (default: 32)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createWaveFromFunction(
  audioContext: AudioContext,
  waveFunction: (phase: number) => number,
  options: {
    harmonics?: number;
  } = {}
): PeriodicWave {
  const { harmonics = 32 } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  const sampleCount = 2048;
  const samples = new Float32Array(sampleCount);

  // Sample the function
  for (let i = 0; i < sampleCount; i++) {
    const phase = (i / sampleCount) * 2 * Math.PI;
    samples[i] = waveFunction(phase);
  }

  // Perform DFT to extract harmonics
  for (let n = 1; n <= harmonics; n++) {
    let realSum = 0;
    let imagSum = 0;

    for (let i = 0; i < sampleCount; i++) {
      const phase = (i / sampleCount) * 2 * Math.PI * n;
      realSum += samples[i] * Math.cos(phase);
      imagSum += samples[i] * Math.sin(phase);
    }

    real[n] = realSum / sampleCount;
    imag[n] = imagSum / sampleCount;
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a white noise wave with equal energy across all frequencies
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.harmonics - Number of harmonics to generate (default: 64)
 * @param options.seed - Optional seed for reproducible noise (if not provided, uses random)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createWhiteNoise(
  audioContext: AudioContext,
  options: {
    harmonics?: number;
    seed?: number;
  } = {}
): PeriodicWave {
  const { harmonics = 64, seed } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  // Simple pseudo-random number generator for reproducible noise
  let rng = seed !== undefined ? seed : Math.random() * 1000000;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };

  for (let n = 1; n <= harmonics; n++) {
    // White noise has equal amplitude across all frequencies
    const amplitude = 1 / Math.sqrt(harmonics); // Normalize for equal power
    const phase = random() * 2 * Math.PI;

    real[n] = amplitude * Math.cos(phase);
    imag[n] = amplitude * Math.sin(phase);
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a pink noise wave with 1/f frequency response (3dB per octave rolloff)
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.harmonics - Number of harmonics to generate (default: 64)
 * @param options.seed - Optional seed for reproducible noise (if not provided, uses random)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createPinkNoise(
  audioContext: AudioContext,
  options: {
    harmonics?: number;
    seed?: number;
  } = {}
): PeriodicWave {
  const { harmonics = 64, seed } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  // Simple pseudo-random number generator for reproducible noise
  let rng = seed !== undefined ? seed : Math.random() * 1000000;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };

  for (let n = 1; n <= harmonics; n++) {
    // Pink noise: amplitude decreases by 1/sqrt(f), which is 1/sqrt(n) for harmonics
    const amplitude = 1 / Math.sqrt(n * harmonics); // Normalize
    const phase = random() * 2 * Math.PI;

    real[n] = amplitude * Math.cos(phase);
    imag[n] = amplitude * Math.sin(phase);
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a brown/red noise wave with 1/f² frequency response (6dB per octave rolloff)
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.harmonics - Number of harmonics to generate (default: 64)
 * @param options.seed - Optional seed for reproducible noise (if not provided, uses random)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createBrownNoise(
  audioContext: AudioContext,
  options: {
    harmonics?: number;
    seed?: number;
  } = {}
): PeriodicWave {
  const { harmonics = 64, seed } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  // Simple pseudo-random number generator for reproducible noise
  let rng = seed !== undefined ? seed : Math.random() * 1000000;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };

  for (let n = 1; n <= harmonics; n++) {
    // Brown noise: amplitude decreases by 1/f, which is 1/n for harmonics
    const amplitude = 1 / (n * Math.sqrt(harmonics)); // Normalize
    const phase = random() * 2 * Math.PI;

    real[n] = amplitude * Math.cos(phase);
    imag[n] = amplitude * Math.sin(phase);
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a custom colored noise with adjustable spectral slope
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.slope - Spectral slope (-2 = brown, -1 = pink, 0 = white, 1 = blue, 2 = violet, default: 0)
 * @param options.harmonics - Number of harmonics to generate (default: 64)
 * @param options.seed - Optional seed for reproducible noise (if not provided, uses random)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createColoredNoise(
  audioContext: AudioContext,
  options: {
    harmonics?: number;
    seed?: number;
    slope?: number;
  } = {}
): PeriodicWave {
  const { slope = 0, harmonics = 64, seed } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  // Simple pseudo-random number generator for reproducible noise
  let rng = seed !== undefined ? seed : Math.random() * 1000000;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };

  for (let n = 1; n <= harmonics; n++) {
    // Colored noise: amplitude = 1/n^(slope/2)
    const amplitude = 1 / (Math.pow(n, slope / 2) * Math.sqrt(harmonics));
    const phase = random() * 2 * Math.PI;

    real[n] = amplitude * Math.cos(phase);
    imag[n] = amplitude * Math.sin(phase);
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}

/**
 * Creates a random harmonic wave with controllable chaos
 * @param audioContext - The Web Audio API context
 * @param options - Configuration options
 * @param options.chaos - Amount of randomness in harmonic amplitudes (0-1, default: 0.5)
 * @param options.harmonicDensity - Probability of each harmonic being present (0-1, default: 0.7)
 * @param options.harmonics - Number of harmonics to generate (default: 32)
 * @param options.seed - Optional seed for reproducible randomness (if not provided, uses random)
 * @returns PeriodicWave for use with OscillatorNode
 */
export function createRandomHarmonicWave(
  audioContext: AudioContext,
  options: {
    harmonics?: number;
    seed?: number;
    chaos?: number;
    harmonicDensity?: number;
  } = {}
): PeriodicWave {
  const { chaos = 0.5, harmonicDensity = 0.7, harmonics = 32, seed } = options;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);

  // Simple pseudo-random number generator for reproducible chaos
  let rng = seed !== undefined ? seed : Math.random() * 1000000;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };

  for (let n = 1; n <= harmonics; n++) {
    // Randomly decide if this harmonic should be present
    if (random() < harmonicDensity) {
      // Base amplitude with random variation
      const baseAmplitude = 1 / n; // Natural harmonic falloff
      const randomFactor = 1 + (random() - 0.5) * 2 * chaos;
      const amplitude = baseAmplitude * randomFactor;

      const phase = random() * 2 * Math.PI;

      // Randomly choose between sine and cosine components
      if (random() > 0.5) {
        real[n] = amplitude * Math.cos(phase);
      } else {
        imag[n] = amplitude * Math.sin(phase);
      }
    }
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
}
