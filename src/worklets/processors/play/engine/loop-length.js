// Pure loop length stages: quantize, glide, keytrack and drift. No state and no
// allocation; these run per sample. Lengths are in source samples.

// One-pole coefficient per sample; 1 = stepped.
export function glideCoefficient(seconds, sampleRate) {
  return seconds > 0 ? -Math.expm1(-1 / sampleRate / seconds) : 1;
}

// One step toward the target, landing on it once within snapDistance.
export function glideToward(current, target, coefficient, snapDistance) {
  const next = current + (target - current) * coefficient;
  return Math.abs(target - next) > snapDistance ? next : target;
}

// `periods` is ascending, or undefined when no scale is set.
export function isInQuantizationRange(length, periods) {
  return !!periods?.length && length >= 1 && length <= periods.at(-1);
}

// Select the nearest period target; glide is applied separately.
export function quantizeLoopLength(length, periods) {
  if (!isInQuantizationRange(length, periods)) return length;
  let best = periods[0];
  let distance = Math.abs(best - length);
  for (let i = 1; i < periods.length; i++) {
    const candidateDistance = Math.abs(periods[i] - length);
    if (candidateDistance < distance) {
      best = periods[i];
      distance = candidateDistance;
    }
  }
  return best;
}

// Longest period no longer than `length`, or undefined if none fits. `periods` is ascending.
export function longestPeriodWithin(length, periods) {
  for (let i = (periods?.length ?? 0) - 1; i >= 0; i--) {
    if (periods[i] <= length) return periods[i];
  }
  return undefined;
}

// Scales from 1 (amount 0) to |playbackRate| (amount 1). When resampling, amount 1 keeps
// the loop's real-time duration across notes. Period stretch loops on a unit-rate
// timeline, so it scales by 1 / |playbackRate| to mirror that: amount 0 keeps it instead.
export function keytrackLoopDuration(duration, amount, playbackRate, isStretched = false) {
  const rate = Math.abs(playbackRate);
  const scale = 1 + amount * ((isStretched ? 1 / rate : rate) - 1);
  return Math.max(1, Math.floor(duration * scale));
}

// Loop iterations between drift rolls. Audio-rate loops re-roll less often.
export function driftRollInterval(duration, pitchPreservationThreshold) {
  return Math.max(1, Math.floor(pitchPreservationThreshold / duration));
}

/**
 * @param {number} randomValue - In [0, 1)
 * @param {number} driftAmount - Maximum drift as a fraction of the loop (0-1)
 * @param {number} duration - Loop duration in samples
 * @returns {number} - Whole-sample drift, positive or negative
 */
export function loopDriftSamples(randomValue, driftAmount, duration) {
  // Scale from 10% at 1024 samples (~23ms at 44.1kHz) to 100% at 8192 (~186ms),
  // so short loops keep their pitch.
  const shortThreshold = 1024;
  const longThreshold = 8192;
  const position = (duration - shortThreshold) / (longThreshold - shortThreshold);
  const durationScale = 0.1 + 0.9 * Math.max(0, Math.min(1, position));

  const randomFactor = (randomValue - 0.5) * 2;

  // Round to the nearest source sample: floor turns even tiny negative drift
  // into a full-sample shortening of the loop.
  return Math.round(randomFactor * driftAmount * durationScale * duration);
}

// Moves the loop end by `drift`, keeping at least 10% of the loop.
export function driftLoopEnd(loopStart, loopEnd, duration, drift, playbackEnd) {
  const minDuration = Math.max(1, Math.floor(duration * 0.1));
  // Ceiling is the keytracked end when it already reaches past the audio,
  // otherwise drift would pull the silence-padded tail back in.
  const maxEnd = Math.max(playbackEnd, loopEnd);
  return Math.max(loopStart + minDuration, Math.min(maxEnd, loopEnd + drift));
}
