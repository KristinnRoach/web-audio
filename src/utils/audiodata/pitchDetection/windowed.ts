interface PitchCandidate {
  frequency: number;
  confidence: number;
  time: number;
}

const MAX_Hz = 4000;
const MIN_Hz = 80;

export async function detectPitchWindowed(
  audioBuffer: AudioBuffer
): Promise<{ frequency: number; confidence: number }> {
  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // Window parameters
  const windowSize = 4096; // ~93ms at 44.1kHz
  const hopSize = 1024; // 75% overlap for smooth tracking
  const numWindows = Math.floor((data.length - windowSize) / hopSize) + 1;

  const pitchCandidates: PitchCandidate[] = [];

  // Analyze each window
  for (let w = 0; w < numWindows; w++) {
    const start = w * hopSize;
    const end = Math.min(start + windowSize, data.length);
    const windowData = data.slice(start, end);

    const result = analyzeWindow(windowData, sampleRate);
    if (result.frequency > 0 && result.confidence > 0.3) {
      // Minimum confidence threshold
      pitchCandidates.push({
        frequency: result.frequency,
        confidence: result.confidence,
        time: start / sampleRate,
      });
    }
  }

  if (pitchCandidates.length === 0) {
    return { frequency: 0, confidence: 0 }; // No pitch detected
  }

  return findMostProminentFundamental(pitchCandidates);
}

function analyzeWindow(
  windowData: Float32Array,
  sampleRate: number
): { frequency: number; confidence: number } {
  // Pad window if too short
  if (windowData.length < 1000) {
    return { frequency: 0, confidence: 0 };
  }

  let correlations = new Float32Array(1000);

  // Center-clipping (reduced threshold for vocals)
  const clipLevel = 0.15 * Math.max(...windowData.map(Math.abs));
  const clipped = windowData.map((x) => (Math.abs(x) > clipLevel ? x : 0));

  // Check if we have enough signal after clipping
  const nonZeroSamples = clipped.filter((x) => x !== 0).length;
  if (nonZeroSamples < windowData.length * 0.1) {
    // Too much was clipped, use raw data
    clipped.set(windowData);
  }

  // Autocorrelation
  for (let lag = 20; lag < correlations.length; lag++) {
    let sum = 0;
    for (let i = 0; i < clipped.length - lag; i++) {
      sum += clipped[i] * clipped[i + lag];
    }
    correlations[lag] = sum;
  }

  // Find peak correlation
  const minLag = Math.floor(sampleRate / MAX_Hz); // upper bound freq
  const maxLag = Math.floor(sampleRate / MIN_Hz); // lower bound

  let bestLag = minLag;
  let maxCorr = correlations[minLag];

  for (let i = minLag; i < Math.min(maxLag, correlations.length); i++) {
    if (correlations[i] > maxCorr) {
      bestLag = i;
      maxCorr = correlations[i];
    }
  }

  // Calculate confidence (peak vs average)
  const avgCorr =
    correlations
      .slice(minLag, Math.min(maxLag, correlations.length))
      .reduce((sum, val) => sum + val, 0) /
    (Math.min(maxLag, correlations.length) - minLag);

  const confidence = avgCorr > 0 ? maxCorr / avgCorr : 0;

  // Quadratic interpolation for sub-sample precision
  if (bestLag > 0 && bestLag < correlations.length - 1) {
    const y1 = correlations[bestLag - 1];
    const y2 = correlations[bestLag];
    const y3 = correlations[bestLag + 1];

    // Quadratic interpolation for fractional‐lag refinement:
    // offset = (y3 – y1) / (2 * (2*y2 – y1 – y3))
    const denominator = 2 * (2 * y2 - y1 - y3);
    const offset = Math.abs(denominator) < 1e-10 ? 0 : (y3 - y1) / denominator;

    const frequency = sampleRate / (bestLag + offset);

    return { frequency, confidence };
  }

  return { frequency: 0, confidence: 0 };
}

function findMostProminentFundamental(candidates: PitchCandidate[]): {
  frequency: number;
  confidence: number;
} {
  // Group similar pitches (within 20 cents tolerance)
  const groups: PitchCandidate[][] = [];
  const tolerance = 0.02; // ~20 cents

  for (const candidate of candidates) {
    let foundGroup = false;

    for (const group of groups) {
      const avgPitch =
        group.reduce((sum, c) => sum + c.frequency, 0) / group.length;
      const ratio = candidate.frequency / avgPitch;

      // Check if within tolerance (accounting for octave errors)
      if (
        Math.abs(ratio - 1) < tolerance ||
        Math.abs(ratio - 0.5) < tolerance ||
        Math.abs(ratio - 2) < tolerance
      ) {
        // Normalize to same octave as group average
        let normalizedPitch = candidate.frequency;
        if (Math.abs(ratio - 0.5) < tolerance) normalizedPitch *= 2;
        if (Math.abs(ratio - 2) < tolerance) normalizedPitch /= 2;

        group.push({ ...candidate, frequency: normalizedPitch });
        foundGroup = true;
        break;
      }
    }

    if (!foundGroup) {
      groups.push([candidate]);
    }
  }

  // Find group with highest total confidence
  let bestGroup = groups[0];
  let bestScore = 0;

  for (const group of groups) {
    const totalConfidence = group.reduce((sum, c) => sum + c.confidence, 0);
    const avgConfidence = totalConfidence / group.length;
    const duration = group.length; // Number of windows

    // Score = average confidence * duration (favors sustained notes)
    const score = avgConfidence * Math.sqrt(duration);

    if (score > bestScore) {
      bestScore = score;
      bestGroup = group;
    }
  }
  // Calculate final confidence
  const avgConfidence =
    bestGroup.reduce((sum, c) => sum + c.confidence, 0) / bestGroup.length;

  // Return weighted average of best group
  const totalWeight = bestGroup.reduce((sum, c) => sum + c.confidence, 0);
  const weightedPitch =
    bestGroup.reduce((sum, c) => sum + c.frequency * c.confidence, 0) /
    totalWeight;

  return { frequency: weightedPitch, confidence: avgConfidence };
}
