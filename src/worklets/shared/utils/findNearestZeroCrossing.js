import { findClosest, findClosestIdx } from "@/utils/search/findClosest";

function crossingSlope(samples, position) {
  const center = Math.round(position);
  const left = Math.max(0, center - 1);
  const right = Math.min(samples.length - 1, center + 1);
  return Math.sign(samples[right] - samples[left]);
}

/**
 * Finds a sample position in an ascending list of zero crossings.
 * Between crossings, `left` selects the lower crossing, `right` the higher,
 * and `any` the nearest (preferring left on a tie). Positions outside the list
 * clamp to its first or last crossing. Returns `position` when the list is empty
 * or the selected crossing is farther away than `maxDistance`.
 *
 * @param {number[]} zeroCrossings Zero-crossing positions in ascending sample order.
 * @param {number} position Target position in samples.
 * @param {"left" | "right" | "any"} [direction="any"] Selection direction.
 * @param {number | null} [maxDistance=null] Maximum allowed distance in samples.
 * @returns {number} The selected crossing, or the unchanged target position.
 */
export function findNearestZeroCrossing(
  zeroCrossings,
  position,
  direction = "any",
  maxDistance = null,
) {
  if (!zeroCrossings?.length) return position;

  const closestValue = findClosest(zeroCrossings, position, direction);
  return maxDistance !== null && Math.abs(closestValue - position) > maxDistance
    ? position
    : closestValue;
}

/**
 * Finds the nearest zero crossing whose slope matches a reference crossing.
 * Returns null when no matching crossing exists within `maxDistance`.
 *
 * @param {number[]} zeroCrossings Zero-crossing positions in ascending sample order.
 * @param {Float32Array} samples Channel used to detect the zero crossings.
 * @param {number} position Target position in samples.
 * @param {number} referencePosition Crossing whose slope must be matched.
 * @param {number} maxDistance Maximum allowed distance from the target in samples.
 * @returns {number | null}
 */
export function findNearestSlopeMatchedZeroCrossing(
  zeroCrossings,
  samples,
  position,
  referencePosition,
  maxDistance,
) {
  if (!zeroCrossings?.length || !samples?.length) return null;

  const referenceSlope = crossingSlope(samples, referencePosition);
  const closestIndex = findClosestIdx(zeroCrossings, position);
  let left = zeroCrossings[closestIndex] <= position ? closestIndex : closestIndex - 1;
  let right = left + 1;

  while (left >= 0 || right < zeroCrossings.length) {
    const leftDistance = left >= 0 ? position - zeroCrossings[left] : Infinity;
    const rightDistance = right < zeroCrossings.length ? zeroCrossings[right] - position : Infinity;
    const index = leftDistance <= rightDistance ? left-- : right++;
    const crossing = zeroCrossings[index];

    if (Math.abs(crossing - position) > maxDistance) return null;
    if (crossingSlope(samples, crossing) === referenceSlope) return crossing;
  }

  return null;
}
