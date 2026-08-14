export function normalizeRange(
  value: number,
  inputMin: number,
  inputMax: number,
  targetMin: number,
  targetMax: number
): number {
  if (inputMin === inputMax) throw new Error('Input range must not be zero.');
  const ratio = (value - inputMin) / (inputMax - inputMin);
  return ratio * (targetMax - targetMin) + targetMin;
}

/* Explicit version below in case i get confused
/**
 * Maps a number from one range to another.
 *
 * @param value - The number to be normalized.
 * @param inputStart - The lower bound of the input range.
 * @param inputEnd - The upper bound of the input range.
 * @param outputStart - The lower bound of the output range.
 * @param outputEnd - The upper bound of the output range.
 * @returns The normalized value in the output range.
 * @throws If the input range is zero (inputStart === inputEnd).
 */
/*
export function normalizeValueToRange(
  value: number,
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number
): number {
  // Check for invalid input range
  if (inputStart === inputEnd) {
    throw new Error("The input range cannot be zero (inputStart must not equal inputEnd).");
  }

  // Calculate the position of 'value' within the input range as a ratio (between 0 and 1)
  const inputRange = inputEnd - inputStart;
  const valueRelativeToInputStart = value - inputStart;
  const ratioWithinInputRange = valueRelativeToInputStart / inputRange;

  // Use the ratio to find the corresponding value in the output range
  const outputRange = outputEnd - outputStart;
  const valueRelativeToOutputStart = ratioWithinInputRange * outputRange;
  const normalizedValue = outputStart + valueRelativeToOutputStart;

  return normalizedValue;
}
*/
