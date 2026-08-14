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
  noiseReduction: keyof typeof clipThresholds = 'medium'
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

  let correlations = new Float32Array(maxLag);

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

  // Quadratic interpolation for sub-sample precision
  const x = bestLag;
  const y1 = correlations[x - 1];
  const y2 = correlations[x];
  const y3 = correlations[x + 1];

  const denominator = 2 * (2 * y2 - y1 - y3);
  const offset = Math.abs(denominator) < 1e-6 ? 0 : (y3 - y1) / denominator;

  // Add confidence calculation
  const maxCorrelation = correlations[bestLag];
  const rms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
  const normalizedMax = maxCorrelation / (rms * rms * data.length);

  const confidence = Math.max(0, Math.min(1, normalizedMax));

  return {
    frequency: audioBuffer.sampleRate / (x + offset),
    confidence: confidence,
  };
}
