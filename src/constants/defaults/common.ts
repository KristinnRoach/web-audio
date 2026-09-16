export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_NUMBER_OF_CHANNELS = 2;

export const audioConfig = {
  sampleRate: DEFAULT_SAMPLE_RATE,
  numberOfChannels: DEFAULT_NUMBER_OF_CHANNELS,
} as const;

/**
 * Filter Q shared by every lowpass/highpass in the lib. One value for both so
 * pre-FX (voice) and post-FX (bus) filters have the same slope knee and can be
 * A/B'd against each other.
 */
export const LPF_Q = 0.666;
export const HPF_Q = 0.666;

/** setTargetAtTime time constant for cutoff moves, shared by voice and bus. */
export const CUTOFF_SMOOTHING_SEC = 0.1;
