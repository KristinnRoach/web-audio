const MIN_Hz = 30;
const MAX_Hz = 1000; // ac only works below 1000Hz

const clipThresholds = {
  off: 0,
  low: 0.1,
  medium: 0.2,
  high: 0.3,
} as const;

export async function detectSinglePitchAC(
  audioBuffer: AudioBuffer,
  noiseReduction: keyof typeof clipThresholds = "medium",
) {
  const rawData = audioBuffer.getChannelData(0);
  const clipThreshold = clipThresholds[noiseReduction];

  let maxAbs = 0;
  for (let i = 0; i < rawData.length; i++) {
    const abs = Math.abs(rawData[i]);
    if (abs > maxAbs) maxAbs = abs;
  }

  const data =
    clipThreshold > 0
      ? rawData.map((x) => (Math.abs(x) > clipThreshold * maxAbs ? x : 0))
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
  // confidence 0.997. Prefer the shortest lag whose peak is nearly as strong.
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

  // Add confidence calculation
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

  const confidence = Math.max(0, Math.min(1, normalizedMax));

  return {
    frequency: audioBuffer.sampleRate / (x + offset),
    confidence: confidence,
  };
}
