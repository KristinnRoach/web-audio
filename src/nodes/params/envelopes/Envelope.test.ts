import { describe, expect, it } from "vite-plus/test";
import { interpolateAtTime } from "./Envelope";

/**
 * Guards the release handoff: `interpolateAtTime` is what lets a release scheduled in
 * the future start from where the envelope will actually be, rather than from
 * `param.value`, which only ever answers for now.
 */
describe("interpolateAtTime", () => {
  const points = [
    { time: 0, value: 0, curve: "linear" as const },
    { time: 1, value: 1, curve: "exponential" as const },
    { time: 2, value: 0.25, curve: "step" as const },
    { time: 3, value: 0 },
  ];

  it("clamps outside the shape instead of extrapolating", () => {
    expect(interpolateAtTime(points, -5)).toBe(0);
    expect(interpolateAtTime(points, 99)).toBe(0);
    expect(interpolateAtTime([], 1)).toBe(0);
  });

  it("returns point values exactly on the points", () => {
    expect(interpolateAtTime(points, 0)).toBe(0);
    expect(interpolateAtTime(points, 1)).toBe(1);
    expect(interpolateAtTime(points, 2)).toBe(0.25);
  });

  it("follows each segment's own curve", () => {
    expect(interpolateAtTime(points, 0.5)).toBeCloseTo(0.5); // linear
    expect(interpolateAtTime(points, 1.5)).toBeCloseTo(0.5); // exponential: 1 * 0.25^0.5
    expect(interpolateAtTime(points, 2.5)).toBe(0.25); // step holds the left value
  });

  it("falls back to linear where an exponential segment touches zero", () => {
    const throughZero = [
      { time: 0, value: 0, curve: "exponential" as const },
      { time: 1, value: 1 },
    ];
    expect(interpolateAtTime(throughZero, 0.5)).toBeCloseTo(0.5);
  });

  it("survives coincident point times", () => {
    const stacked = [
      { time: 0, value: 0 },
      { time: 1, value: 0.5 },
      { time: 1, value: 1 },
      { time: 2, value: 0 },
    ];
    expect(Number.isFinite(interpolateAtTime(stacked, 1))).toBe(true);
  });
});
