import { describe, it, expect } from "vite-plus/test";
import { applyFade } from "../trimBuffer";

const ones = (n: number) => new Float32Array(n).fill(1);

describe("applyFade", () => {
  it("fades in from silence to full", () => {
    const data = ones(64);
    applyFade(data, 0, 64, "in");
    expect(data[0]).toBe(0);
    expect(data[32]).toBeCloseTo(0.5, 5);
    expect(data[63]).toBeGreaterThan(0.99);
  });

  it("fades out from full to near silence", () => {
    const data = ones(64);
    applyFade(data, 0, 64, "out");
    expect(data[0]).toBe(1);
    expect(data[32]).toBeCloseTo(0.5, 5);
    expect(data[63]).toBeLessThan(0.01);
  });

  it("starts and ends with a flat slope (the reason for raised cosine)", () => {
    const data = ones(64);
    applyFade(data, 0, 64, "in");
    const firstStep = data[1] - data[0];
    const midStep = data[32] - data[31];
    // Linear would make these equal; raised cosine eases in.
    expect(firstStep).toBeLessThan(midStep / 10);
  });

  it("only touches the fade region", () => {
    const data = ones(64);
    applyFade(data, 16, 16, "out");
    expect(data[15]).toBe(1);
    expect(data[32]).toBe(1);
    expect(data[16]).toBe(1);
    expect(data[24]).toBeLessThan(1);
  });
});
