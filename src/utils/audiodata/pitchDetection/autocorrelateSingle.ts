const MIN_Hz = 30;
const MAX_Hz = 1000; // ac only works below 1000Hz

const clipThresholds = {
  off: 0,
  low: 0.1,
  medium: 0.2,
  high: 0.3,
} as const;

/**
 * Which amplitude the center-clip threshold is measured against, as a quantile
 * of |sample| - the fraction of the recording allowed to sit ABOVE the reference.
 *
 * Balances a STRONG pitch against a SUSTAINED one:
 *   1.0  reference is the single loudest sample, so the loudest transient wins.
 *   <1.0 steps over the loudest (1 - value) of the recording, so the sustained
 *        body sets the reference and a short strong sound stops dominating.
 *
 * At 1.0 this is exactly the old peak-referenced behaviour, bit for bit - so if
 * this tuning does not help, set it to 1.0 to confirm, then delete the quantile
 * block below and go back to a plain max-of-|sample| loop.
 *
 * Pick it from the transient you want ignored: stay under
 * 1 - (transient length / sample duration). A 5ms click in a 500ms sample is 1%,
 * so 0.99 or below clears it. Measured flat from 0.99 down to 0.75 on transient
 * fixtures; below ~0.5 the reference sinks into the noise floor and clipping
 * stops rejecting anything.
 */
const AMPLITUDE_QUANTILE = 0.95;

export async function detectSinglePitchAC(
  audioBuffer: AudioBuffer,
  noiseReduction: keyof typeof clipThresholds = "medium",
) {
  const rawData = audioBuffer.getChannelData(0);
  const clipThreshold = clipThresholds[noiseReduction];

  // Sorted ascending, so index (n - 1) * quantile is the reference amplitude.
  // TypedArray sort puts NaN last, so dropping the NaN tail leaves the finite
  // values and keeps the old behaviour of skipping them.
  const sortedAbs = Float32Array.from(rawData, Math.abs).sort();

  let finiteCount = sortedAbs.length;
  while (finiteCount > 0 && Number.isNaN(sortedAbs[finiteCount - 1])) finiteCount--;

  if (finiteCount < sortedAbs.length) {
    console.warn(
      `detectSinglePitchAC: ignoring ${sortedAbs.length - finiteCount} NaN sample(s) in the input buffer`,
    );
  }

  const referenceAmplitude =
    finiteCount > 0 ? sortedAbs[Math.floor((finiteCount - 1) * AMPLITUDE_QUANTILE)] : 0;

  const data =
    clipThreshold > 0
      ? rawData.map((x) => (Math.abs(x) > clipThreshold * referenceAmplitude ? x : 0))
      : rawData;

  const minLag = Math.floor(audioBuffer.sampleRate / MAX_Hz); // upper bound
  const maxLag = Math.floor(audioBuffer.sampleRate / MIN_Hz); // lower bound

  const correlations = new Float32Array(maxLag);

  // Autocorrelation
  for (let lag = minLag; lag < correlations.length; lag++) {
    let sum = 0;
    for (let i = 0; i < data.length - lag; i++) {
      sum += data[i] * data[i + lag];
    }
    correlations[lag] = sum;
  }

  // Find peak correlation excluding short lags
  let bestLag = minLag;
  for (let i = minLag; i < maxLag; i++) {
    if (correlations[i] > correlations[bestLag]) bestLag = i;
  }

  // Autocorrelation peaks at every multiple of the true period, and for a mix of
  // pitches also at the mixture's common period - both LONGER than the pitch we
  // want. Left alone, a dominant note plus a second tone 12dB down resolves to the
  // common period: 277Hz + 220Hz reads as 55Hz, a 3.9 semitone tuning error at
  // periodicity 0.997. Prefer the shortest lag whose peak is nearly as strong.
  //
  // Scanning a window around bestLag / k because the divided lag lands off-grid.
  // Descending k so the shortest qualifying lag wins. Ratio is flat over 0.7-0.9
  // on the mixture fixtures, so 0.8 sits mid-plateau rather than on an edge.
  const SUBHARMONIC_RATIO = 0.8;
  const MAX_SUBHARMONIC = 6;
  for (let k = MAX_SUBHARMONIC; k >= 2; k--) {
    const candidate = Math.round(bestLag / k);
    if (candidate < minLag) continue;

    const window = Math.max(1, Math.round(candidate * 0.02));
    let localBest = candidate;
    const from = Math.max(minLag, candidate - window);
    const to = Math.min(maxLag - 1, candidate + window);
    for (let i = from; i <= to; i++) {
      if (correlations[i] > correlations[localBest]) localBest = i;
    }

    if (correlations[localBest] >= SUBHARMONIC_RATIO * correlations[bestLag]) {
      bestLag = localBest;
      break;
    }
  }

  // Quadratic interpolation for sub-sample precision
  const x = bestLag;
  let offset = 0;
  if (x > 0 && x < correlations.length - 1) {
    const y1 = correlations[x - 1];
    const y2 = correlations[x];
    const y3 = correlations[x + 1];

    const denominator = 2 * (2 * y2 - y1 - y3);
    const interpolated = Math.abs(denominator) < 1e-6 ? 0 : (y3 - y1) / denominator;

    // A true peak interpolates to within half a bin. Anything beyond that means
    // bestLag wasn't a real local max (it sits on the search boundary, where
    // correlations[minLag - 1] is still 0, or the peak is near-flat) and the
    // parabola has opened the wrong way. Unclamped, that yields a wild or
    // negative lag, and sampleRate / negative propagates NaN to the caller.
    offset = Math.max(-0.5, Math.min(0.5, interpolated));
  }

  // Add periodicity calculation
  const maxCorrelation = correlations[bestLag];
  const energy = data.reduce((sum, x) => sum + x * x, 0);
  // const normalizedMax = energy > 0 ? maxCorrelation / energy : 0;

  // r[τ] sums only data.length - bestLag terms while energy (r[0]) sums all of
  // them, so the raw ratio is tapered down by τ/N = 1/(f * durationSeconds) —
  // i.e. by 1/(number of fundamental cycles in the buffer). That penalises low
  // pitches and short samples for reasons unrelated to pitch quality. Undo it
  // here so scores are comparable across sources.
  //
  // Deliberately NOT applied to the bestLag search above: the biased estimator's
  // taper is what suppresses spurious long-lag peaks, and removing it there
  // invites sub-octave errors.
  const overlapCorrection = data.length / (data.length - bestLag);
  const normalizedMax = energy > 0 ? (maxCorrelation / energy) * overlapCorrection : 0;

  const periodicity = Math.max(0, Math.min(1, normalizedMax));

  return {
    frequency: audioBuffer.sampleRate / (x + offset),
    /**
     * How strongly the waveform repeats at the detected period: effectively a
     * pitch-vs-noise measure. Noise and silence score near 0, anything pitched
     * scores above 0.9, so it is a reliable gate for "is this worth tuning".
     *
     * It does NOT say the returned frequency is the pitch you wanted. A mixture
     * of notes is highly periodic at its common period, so a wrong answer on a
     * chord scores higher (0.997) than a correct one on a clean decaying note
     * (0.969). Use it to reject noise, not to trust the frequency.
     */
    periodicity,
  };
}
