/**
 * Where a playhead moving in `direction` lands once it has left the loop through
 * the edge it was heading toward, or null while it is inside [loopStart, loopEnd).
 *
 * The overshoot is carried to keep the loop period exact. An overshoot of a whole
 * loop or more (loop points moved behind the playhead between blocks) would land
 * outside the loop, so it lands on the far edge instead.
 *
 * Pure, and the loop range is plain arguments, so it serves the playhead and the
 * duration preserver's timeline alike, with block-rate or per-sample ranges.
 * @param {number} position Playhead position in source samples.
 * @param {1 | -1} direction 1 forward, -1 reverse.
 * @param {number} loopStart Inclusive loop start in source samples.
 * @param {number} loopEnd Exclusive loop end in source samples.
 * @returns {number | null}
 */
export function wrapLoopPosition(position, direction, loopStart, loopEnd) {
  const loopLength = loopEnd - loopStart;
  if (direction > 0 && position >= loopEnd) {
    const overshoot = position - loopEnd;
    return loopStart + (overshoot < loopLength ? overshoot : 0);
  }
  if (direction < 0 && position < loopStart) {
    const overshoot = loopStart - position;
    return loopEnd - (overshoot < loopLength ? overshoot : 0);
  }
  return null;
}
