import { findClosest } from "@/utils/search/findClosest";

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
