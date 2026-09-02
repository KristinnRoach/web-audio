import { describe, it, expect } from "vite-plus/test";
import { getKeytrackedFilterHz } from "../index";

describe("getKeytrackedFilterHz", () => {
  it("preserves the cutoff at unity rate regardless of tracking amount", () => {
    expect(getKeytrackedFilterHz(500, 1, 0)).toBe(500);
    expect(getKeytrackedFilterHz(500, 1, 0.5)).toBe(500);
    expect(getKeytrackedFilterHz(500, 1, 1)).toBe(500);
  });

  it("follows playback rate according to the tracking amount", () => {
    expect(getKeytrackedFilterHz(500, 2, 0)).toBe(500);
    expect(getKeytrackedFilterHz(500, 2, 0.5)).toBeCloseTo(500 * Math.SQRT2);
    expect(getKeytrackedFilterHz(500, 2, 1)).toBe(1000);
    expect(getKeytrackedFilterHz(500, 0.5, 0.5)).toBeCloseTo(500 / Math.SQRT2);
  });
});
