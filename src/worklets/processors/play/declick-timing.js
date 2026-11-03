// Internal listening-test duration multipliers; 1 = baseline, 0 = bypass.
// Keep timestretch independent. Rebuild/reload the worklet after edits.
const LOOP_WRAP_DURATION_SCALE = 1;
// Repeated relocations accumulate correction; long decay can cause LF rumble.
const LOOP_MOVE_DURATION_SCALE = 1;
const SILENT_TAIL_DURATION_SCALE = 1;

/** Tune each correction independently; keep durations stable across sample rates. */
export function getDeclickTiming(
  contextSampleRate,
  wrapScale = LOOP_WRAP_DURATION_SCALE,
  moveScale = LOOP_MOVE_DURATION_SCALE,
  tailScale = SILENT_TAIL_DURATION_SCALE,
) {
  return {
    // Baseline 0.9 per frame at 48 kHz; 99% decay in ~0.91 ms.
    wrapCorrectionDecay: wrapScale === 0 ? 0 : 0.9 ** (48_000 / contextSampleRate / wrapScale),
    moveCorrectionDecay: moveScale === 0 ? 0 : 0.9 ** (48_000 / contextSampleRate / moveScale),
    // Source-domain ramp: its audible duration also depends on playback rate.
    tailFadeSamples: (64 / 48_000) * contextSampleRate * tailScale,
  };
}
