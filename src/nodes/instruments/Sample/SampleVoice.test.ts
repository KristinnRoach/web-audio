import { describe, expect, it, vi } from "vite-plus/test";

vi.stubGlobal("window", {});
vi.stubGlobal("AudioContext", class {});
vi.stubGlobal("AudioWorkletNode", class {});

const { getKeytrackedFilterHz } = await import("./SampleVoice");

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
  });
});
