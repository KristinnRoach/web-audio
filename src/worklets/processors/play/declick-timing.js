// Internal correctional de-click control, 0..1 (excludes timestretch).
// 0.5 = baseline, 0 bypasses fades.
// 0.25 = 0.1x, 0.75 = 10x, 1 = 100x duration.
const DECLICK_SMOOTHING = 1;

/** Keep each fade's shape and relative duration while scaling time together. */
export function getDeclickTiming(contextSampleRate, amount = DECLICK_SMOOTHING) {
  const scale = amount === 0 ? 0 : 10 ** (4 * amount - 2);
  return {
    // Baseline 0.9 per frame at 48 kHz; 99% decay in ~0.91 ms.
    correctionDecay: scale === 0 ? 0 : 0.9 ** (48_000 / contextSampleRate / scale),
    // Source-domain ramp: its audible duration also depends on playback rate.
    tailFadeSamples: (64 / 48_000) * contextSampleRate * scale,
  };
}
