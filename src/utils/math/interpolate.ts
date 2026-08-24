/**
 * Universal interpolation function with GSAP-inspired easing curves.
 *
 * @param value - Input value to interpolate.
 * @param options - Configuration object containing all parameters.
 * @param options.inputRange - Input domain {min, max}.
 * @param options.outputRange - Output range {min, max}.
 * @param options.curve - Easing curve type (default 'linear').
 *   - 'linear': No easing (power = 1)
 *   - 'power1': Gentle curve (power = 1.5)
 *   - 'power2': Moderate curve (power = 2)
 *   - 'power3': Strong curve (power = 3)
 *   - 'power4': Very strong curve (power = 4)
 *   - 'expo': Exponential curve
 *   - 'log': Logarithmic curve
 *   - 'sine': Sine-based easing
 *   - 'circ': Circular easing
 *   - number: Custom power value
 * @returns Interpolated value with easing applied.
 */
export function interpolate(
  value: number,
  options: {
    inputRange: { min: number; max: number };
    outputRange: { min: number; max: number };
    curve?:
      | "linear"
      | "power1"
      | "power2"
      | "power3"
      | "power4"
      | "expo"
      | "log"
      | "sine"
      | "circ"
      | number;
  },
): number {
  const { inputRange, outputRange, curve = "linear" } = options;

  if (value > inputRange.max || value < inputRange.min) {
    console.warn("interpolate: Value outside of input range, will be clamped");
  }

  // Clamp value within bounds
  const v = Math.max(inputRange.min, Math.min(value, inputRange.max));
  let t = (v - inputRange.min) / (inputRange.max - inputRange.min); // normalized position in [0, 1]

  // Apply easing curve
  switch (curve) {
    case "linear":
      // t remains unchanged
      break;
    case "power1":
      t = Math.pow(t, 1 / 1.5);
      break;
    case "power2":
      t = Math.pow(t, 1 / 2);
      break;
    case "power3":
      t = Math.pow(t, 1 / 3);
      break;
    case "power4":
      t = Math.pow(t, 1 / 4);
      break;
    case "expo":
      t = t === 0 ? 0 : Math.pow(2, 10 * (t - 1));
      break;
    case "log":
      t = Math.log(1 + 9 * t) / Math.log(10);
      break;
    case "sine":
      t = 1 - Math.cos((t * Math.PI) / 2);
      break;
    case "circ":
      t = 1 - Math.sqrt(1 - t * t);
      break;
    default:
      if (typeof curve === "number") {
        t = Math.pow(t, 1 / curve);
      }
      break;
  }

  // Linear interpolation with the eased input
  return outputRange.min + t * (outputRange.max - outputRange.min);
}

/**
 * Interpolates a value from linear (arithmetic) to geometric scaling.
 *
 * Geometric mapping is `outMin * (outMax / outMin) ** t`: equal steps in the input
 * produce equal *ratios* in the output, and the midpoint is the geometric mean of the
 * endpoints rather than the arithmetic mean. This is the curve wanted for frequency,
 * gain and other perceptually ratio-based controls.
 *
 * The mapping is independent of any logarithm base -- base 10, base 2 and base e all
 * cancel out of the expression above and produce identical results -- which is why this
 * takes no base option. "Logarithmic" and "exponential" are both used for this same
 * curve in audio (a log-taper potentiometer rises exponentially), so the unambiguous
 * term is used here instead.
 *
 * Note this warps the *output spacing*. To ease the input and keep a linear output, use
 * `interpolate`.
 *
 * @param value - Input value to interpolate.
 * @param options - Configuration object containing all parameters.
 * @param options.inputRange - Input domain {min, max}.
 * @param options.outputRange - Output range {min, max} (min must be > 0 for geometric interpolation).
 * @param options.blend - Blend between linear (0) and geometric (1) mapping (default 1).
 * @param options.curve - Power curve adjustment: 'linear' | 'smooth' | 'steep' | 'gentle' | number (default 'linear').
 *   - 'linear': No curve adjustment (power = 1)
 *   - 'smooth': Gentle curve (power = 2)
 *   - 'steep': More aggressive curve (power = 3)
 *   - 'gentle': Very gentle curve (power = 1.5)
 *   - number: Custom power value (1 = linear, >1 = more resolution at high end)
 * @returns Interpolated value.
 */
export function interpolateLinearToGeometric(
  value: number,
  options: {
    inputRange: { min: number; max: number };
    outputRange: { min: number; max: number };
    blend?: number;
    curve?: "linear" | "smooth" | "steep" | "gentle" | number;
  },
): number {
  const { inputRange, outputRange, blend = 1, curve = "linear" } = options;

  if (value > inputRange.max || value < inputRange.min) {
    console.warn("interpolateLinearToGeometric: Value outside of input range, will be clamped");
  }

  if (outputRange.min <= 0) {
    console.warn(
      "interpolateLinearToGeometric: Output min must be > 0 for geometric interpolation",
    );
  }

  // Clamp value and blend within bounds
  const v = Math.max(inputRange.min, Math.min(value, inputRange.max));
  let t = (v - inputRange.min) / (inputRange.max - inputRange.min); // normalized position in [0, 1]
  const b = Math.max(0, Math.min(blend, 1));

  // Apply power curve adjustment
  const power =
    typeof curve === "number"
      ? curve
      : curve === "smooth"
        ? 2
        : curve === "steep"
          ? 3
          : curve === "gentle"
            ? 1.5
            : 1;

  if (power !== 1) {
    t = Math.pow(t, 1 / power);
  }

  const linear = outputRange.min + t * (outputRange.max - outputRange.min);
  const geometric = outputRange.min * Math.pow(outputRange.max / outputRange.min, t);

  // Blend: 0=linear, 1=geometric
  return (1 - b) * linear + b * geometric;
}
