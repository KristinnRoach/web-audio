/**
 * Generic binary search that finds the closest element using a custom comparison function
 * @param sortedArray - Array sorted according to the compareValue function
 * @param target - Target value to search for
 * @param getValue - Function to extract comparison value from array elements (defaults to identity for number arrays)
 * @param getDistance - Optional function to calculate distance (defaults to absolute difference)
 * @returns The array index of the element which value is closest to the target value
 */
export function findClosestIdx<T>(
  sortedArray: T[],
  target: number,
  direction: 'left' | 'right' | 'any' = 'any',
  getValue: (item: T) => number = (x) => x as unknown as number,
  getDistance: (a: number, b: number) => number = (a, b) => Math.abs(a - b)
): number {
  if (sortedArray.length === 0) {
    throw new Error('Array cannot be empty');
  }

  if (sortedArray.length === 1) {
    return 0;
  }

  const targetValue = target;
  const firstValue = getValue(sortedArray[0]);
  const lastValue = getValue(sortedArray[sortedArray.length - 1]);

  // Handle edge cases
  if (targetValue <= firstValue) return 0;
  if (targetValue >= lastValue) return sortedArray.length - 1;

  // Binary search for insertion point
  let left = 0;
  let right = sortedArray.length - 1;

  while (left < right - 1) {
    const mid = Math.floor((left + right) / 2);
    const midValue = getValue(sortedArray[mid]);

    if (midValue === targetValue) {
      return mid; // Exact match
    } else if (midValue < targetValue) {
      left = mid;
    } else {
      right = mid;
    }
  }

  // If direction is specified, return the closest value to the left or right
  if (direction === 'left') return left;
  if (direction === 'right') return right;

  // Else compare the two closest candidates
  const leftDistance = getDistance(getValue(sortedArray[left]), targetValue);
  const rightDistance = getDistance(getValue(sortedArray[right]), targetValue);

  return leftDistance <= rightDistance ? left : right;
}

/**
 * Generic binary search that finds the closest element using a custom comparison function
 * @param sortedArray - Array sorted according to the compareValue function
 * @param target - Target value to search for
 * @param getValue - Function to extract comparison value from array elements (defaults to identity for number arrays)
 * @param getDistance - Optional function to calculate distance (defaults to absolute difference)
 * @returns The array element which value is closest to the target value
 */
export function findClosest<T>(
  sortedArray: T[],
  target: number,
  direction: 'left' | 'right' | 'any' = 'any',
  getValue: (item: T) => number = (x) => x as unknown as number,
  getDistance: (a: number, b: number) => number = (a, b) => Math.abs(a - b)
): T {
  const index = findClosestIdx(
    sortedArray,
    target,
    direction,
    getValue,
    getDistance
  );
  return sortedArray[index];
}
