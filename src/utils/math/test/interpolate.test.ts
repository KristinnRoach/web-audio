import { describe, test, expect, vi } from "vite-plus/test";
import { interpolate, interpolateLinearToGeometric } from "../interpolate";

describe("interpolate", () => {
  test("power curves should produce non-linear progression", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 },
    };

    const linear = interpolate(0.5, { ...options, curve: "linear" });
    const power2 = interpolate(0.5, { ...options, curve: "power2" });
    const power4 = interpolate(0.5, { ...options, curve: "power4" });

    expect(linear).toBe(50); // exactly halfway
    expect(power2).toBeGreaterThan(linear); // power curves should give more resolution at high end
    expect(power4).toBeGreaterThan(power2); // higher power = more extreme curve
  });

  test("exponential curve should handle edge cases correctly", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 },
      curve: "expo" as const,
    };

    expect(interpolate(0, options)).toBe(0); // expo curve starts at 0
    expect(interpolate(1, options)).toBe(100); // ends at max
    expect(interpolate(0.5, options)).toBeLessThan(50); // exponential is front-loaded
  });

  test("custom numeric curve should work as power function", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 },
    };

    const customPower = interpolate(0.5, { ...options, curve: 2.5 });
    const power2 = interpolate(0.5, { ...options, curve: "power2" });

    expect(customPower).toBeGreaterThan(power2); // 2.5 power should be between power2 and power3
    expect(customPower).toBeLessThan(interpolate(0.5, { ...options, curve: "power3" }));
  });
});

describe("interpolateLinearToGeometric", () => {
  test("should blend between linear and geometric scaling", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 1000 }, // 3 decades for a clear effect
    };

    const linear = interpolateLinearToGeometric(0.5, { ...options, blend: 0 });
    const geometric = interpolateLinearToGeometric(0.5, { ...options, blend: 1 });
    const blended = interpolateLinearToGeometric(0.5, { ...options, blend: 0.5 });

    expect(linear).toBeCloseTo(500.5, 0); // arithmetic midpoint
    expect(geometric).toBeCloseTo(31.6, 0); // geometric midpoint = sqrt(1 * 1000)
    expect(blended).toBeCloseTo((linear + geometric) / 2, 0); // average of both
    expect(geometric).toBeLessThan(linear); // geometric grows slowly at the start
  });

  test("equal input steps produce equal output ratios", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 1000 },
      blend: 1,
    };

    // outMin * (outMax / outMin) ** t
    const a = interpolateLinearToGeometric(0.25, options);
    const b = interpolateLinearToGeometric(0.5, options);
    const c = interpolateLinearToGeometric(0.75, options);

    expect(a).toBeCloseTo(5.623413252, 6);
    expect(b).toBeCloseTo(31.6227766, 6);
    expect(c).toBeCloseTo(177.827941, 6);
    expect(b / a).toBeCloseTo(c / b, 6);
  });

  test("output ranges below 0.001 are not floored", () => {
    const belowFloor = interpolateLinearToGeometric(0.5, {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0.0001, max: 1 },
      blend: 1,
    });

    // Geometric mean of the actual endpoints, not of a clamped minimum
    expect(belowFloor).toBeCloseTo(Math.sqrt(0.0001), 6);
  });

  test("extreme output ranges do not overflow to Infinity", () => {
    // outMax / outMin would be Infinity here, so the ratio form breaks
    const result = interpolateLinearToGeometric(0.5, {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1e-320, max: 1 },
      blend: 1,
    });

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
    // Geometric mean of the endpoints, to within subnormal log precision
    expect(Math.log10(result)).toBeCloseTo(-160, 3);
  });

  test("should handle audio-typical frequency ranges correctly", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 20, max: 20000 }, // typical audio frequency range
      blend: 1,
    };

    const lowFreq = interpolateLinearToGeometric(0.1, options);
    const midFreq = interpolateLinearToGeometric(0.5, options);
    const highFreq = interpolateLinearToGeometric(0.9, options);

    expect(lowFreq).toBeLessThan(100); // should stay in low range
    expect(midFreq).toBeCloseTo(632, 0); // geometric mean of 20 and 20000
    expect(highFreq).toBeLessThan(20000); // shouldn't quite reach maximum
    expect(highFreq).toBeGreaterThan(midFreq * 2); // should show accelerating growth
  });

  test("curve adjustment should modify the input scaling", () => {
    const options = {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 1, max: 100 },
      blend: 1,
    };

    const linear = interpolateLinearToGeometric(0.5, { ...options, curve: "linear" });
    const steep = interpolateLinearToGeometric(0.5, { ...options, curve: "steep" });

    expect(steep).toBeGreaterThan(linear); // steep curve pushes values higher
  });

  test("should warn for invalid output ranges", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    interpolateLinearToGeometric(0.5, {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: 0, max: 100 }, // min = 0 is invalid for geometric
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "interpolateLinearToGeometric: Output min must be > 0 for geometric interpolation",
    );

    consoleSpy.mockRestore();
  });
});
