export const clamp = (
  value: number,
  min: number,
  max: number,
  options: {
    warn?: boolean;
    name?: string;
  } = { warn: false }
) => {
  if (options.warn && (value < min || value > max)) {
    const paramName = options.name ? `(${options.name})` : '';
    console.warn(
      `Value${paramName} ${value} is outside range [${min}, ${max}], clamping to ${value < min ? min : max}`
    );
  }

  return Math.max(min, Math.min(max, value));
};

export const mapToRange = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  options: {
    warn?: boolean;
    name?: string;
  } = { warn: true }
) => {
  // Check if input is out of bounds
  if (value < inMin || value > inMax) {
    const paramName = options.name ? `(${options.name})` : '';
    if (options.warn) {
      console.warn(
        `Input value${paramName} ${value} is outside nominal range [${inMin}, ${inMax}]`
      );
    }
    // Clamp input value before mapping
    value = clamp(value, inMin, inMax);
  }

  // Handle special case where input range is a point
  if (inMax === inMin) {
    // When mapping from a point, output the middle of the target range
    return (outMax + outMin) / 2;
  }

  // Do the mapping
  const mapped =
    ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;

  // Ensure output is within bounds, considering that output range might be inverted
  return clamp(mapped, Math.min(outMin, outMax), Math.max(outMin, outMax));
};

/** Returns an array of numbers from start (inclusive) to end (exclusive). Start must be less than end.  */
export const range = (start: number, end: number, step = 1) => {
  let output: number[] = [];

  if (start >= end) {
    console.warn(
      `range(): start (${start}) must be less than end (${end}). Returning empty array.`
    );
    return output;
  }

  for (let i = start; i < end; i += step) {
    output.push(i);
  }

  return output;
};

/** Returns a random integer between min (inclusive) and max (exclusive) */
export const randomInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min)) + min;
