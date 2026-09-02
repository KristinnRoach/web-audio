import { describe, it, expect } from "vite-plus/test";
import { clampHz, maxSafeHz, FALLBACK_MAX_HZ, MIN_HZ } from "../audioparam";

describe("maxSafeHz", () => {
  it("leaves a 1 kHz guard band below Nyquist", () => {
    expect(maxSafeHz(48000)).toBe(23000);
    expect(maxSafeHz(44100)).toBe(21050);
  });

  it("falls back without a usable sample rate", () => {
    expect(maxSafeHz()).toBe(FALLBACK_MAX_HZ);
    expect(maxSafeHz(0)).toBe(FALLBACK_MAX_HZ);
  });
});

describe("clampHz", () => {
  it("clamps to the safe range", () => {
    expect(clampHz(500, 48000)).toBe(500);
    expect(clampHz(0, 48000)).toBe(MIN_HZ);
    expect(clampHz(99999, 48000)).toBe(23000);
    expect(clampHz(99999)).toBe(FALLBACK_MAX_HZ);
  });
});
