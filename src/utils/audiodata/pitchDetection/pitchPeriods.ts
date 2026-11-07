const MIN_HZ = 60;
const MAX_HZ = 2000;
const HOPS_PER_SECOND = 100;
const WINDOW_SECONDS = 0.02;
// Below this normalized correlation, a window has no clear pitch.
const MIN_CLARITY = 0.6;
// The period is the first peak this close to the highest. A longer one is usually a subharmonic.
const PEAK_THRESHOLD = 0.9;
const MIN_ENERGY = 1e-6;

export type PitchPeriods = {
  /** Pitch period in samples around each hop. 0 where no pitch is clear. */
  periods: Float32Array;
  hopSamples: number;
};

/**
 * Tracks the local pitch period with normalized autocorrelation (McLeod's pitch method).
 * Unlike detectSinglePitchAC this keeps every reading, so note changes survive.
 * ponytail: every lag on every hop blocks about 0.05 s per second of audio; use an FFT or a worker if long samples stall.
 */
export function detectPitchPeriods(samples: Float32Array, sampleRate: number): PitchPeriods {
  const hopSamples = Math.round(sampleRate / HOPS_PER_SECOND);
  const windowSamples = Math.round(sampleRate * WINDOW_SECONDS);
  const minLag = Math.floor(sampleRate / MAX_HZ);
  const maxLag = Math.ceil(sampleRate / MIN_HZ);
  const frame = new Float32Array(windowSamples + maxLag + 1);
  const scores = new Float32Array(maxLag + 2);
  const periods = new Float32Array(Math.ceil(samples.length / hopSamples) + 1);
  if (samples.length < frame.length) return { periods, hopSamples };

  for (let hop = 0; hop < periods.length; hop++) {
    const centered = hop * hopSamples - (frame.length >> 1);
    const start = Math.max(0, Math.min(samples.length - frame.length, centered));
    let mean = 0;
    for (let i = 0; i < frame.length; i++) mean += samples[start + i] / frame.length;
    for (let i = 0; i < frame.length; i++) frame[i] = samples[start + i] - mean;

    // Lags below minLag are not candidates, but they show where the peak at lag 0 ends.
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      let product = 0;
      let energy = 0;
      for (let i = 0; i < windowSamples; i += 2) {
        product += frame[i] * frame[i + lag];
        energy += frame[i] * frame[i] + frame[i + lag] * frame[i + lag];
      }
      scores[lag] = energy > MIN_ENERGY ? (2 * product) / energy : 0;
    }
    periods[hop] = periodFromScores(scores, minLag, maxLag);
  }
  return { periods, hopSamples };
}

function periodFromScores(scores: Float32Array, minLag: number, maxLag: number) {
  // Skip the peak at lag 0, then look among the peaks after it.
  let lag = 1;
  while (lag < maxLag && scores[lag] > 0) lag++;
  lag = Math.max(lag, minLag);
  let highest = 0;
  for (let i = lag; i <= maxLag; i++) {
    if (isPeak(scores, i) && scores[i] > highest) highest = scores[i];
  }
  if (highest < MIN_CLARITY) return 0;

  while (!isPeak(scores, lag) || scores[lag] < highest * PEAK_THRESHOLD) lag++;
  // A parabola through the peak and its neighbors finds the period between samples.
  const [before, peak, after] = [scores[lag - 1], scores[lag], scores[lag + 1]];
  return lag + (before - after) / (2 * (before - 2 * peak + after) || 1);
}

function isPeak(scores: Float32Array, lag: number) {
  return scores[lag] > 0 && scores[lag] >= scores[lag - 1] && scores[lag] > scores[lag + 1];
}
