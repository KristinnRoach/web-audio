import { describe, it, expect } from "vite-plus/test";
import { applyFade, minFadeSamples, trimAudioBuffer } from "../trimBuffer";

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

describe("minFadeSamples", () => {
  it("holds ~0.2ms at normal sample rates", () => {
    for (const sr of [44100, 48000, 96000, 192000]) {
      const ms = (minFadeSamples(sr) / sr) * 1000;
      expect(ms).toBeGreaterThanOrEqual(0.2);
      expect(ms).toBeLessThan(0.25);
    }
  });

  it("floors at 8 samples so low rates still get a smooth ramp", () => {
    expect(minFadeSamples(8000)).toBe(8);
    expect(minFadeSamples(16000)).toBe(8);
  });
});

describe("trimAudioBuffer fade options", () => {
  const ctx = {
    createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return {
        numberOfChannels,
        length,
        sampleRate,
        getChannelData: (i: number) => channels[i],
      };
    },
  } as unknown as AudioContext;

  const dc = (length: number, sampleRate = 48000) =>
    ({
      numberOfChannels: 1,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length).fill(1),
    }) as unknown as AudioBuffer;

  it("defaults both sides to the shortest safe fade", () => {
    const out = trimAudioBuffer(ctx, dc(1000), 0, 1000, {
      in: "default",
      out: "default",
    }).getChannelData(0);
    const n = minFadeSamples(48000);
    expect(out[0]).toBe(0);
    expect(out[999]).toBeLessThan(1);
    expect(out[n]).toBe(1);
  });

  it("skips the side set to 0", () => {
    const out = trimAudioBuffer(ctx, dc(1000), 0, 1000, { in: 0, out: "default" }).getChannelData(
      0,
    );
    expect(out[0]).toBe(1);
    expect(out[999]).toBeLessThan(1);
  });

  it("applies different lengths per side", () => {
    const out = trimAudioBuffer(ctx, dc(4800), 0, 4800, { in: 10, out: 1 }).getChannelData(0);
    expect(out[479]).toBeLessThan(1); // 10ms = 480 samples
    expect(out[480]).toBe(1);
    expect(out[4800 - 48]).toBe(1); // 1ms = 48 samples
    expect(out[4800 - 47]).toBeLessThan(1);
  });
});

describe("trimAudioBuffer fade fitting", () => {
  const ctx = {
    createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return {
        numberOfChannels,
        length,
        sampleRate,
        getChannelData: (i: number) => channels[i],
      };
    },
  } as unknown as AudioContext;

  const dc = (length: number, sampleRate = 48000) =>
    ({
      numberOfChannels: 1,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length).fill(1),
    }) as unknown as AudioBuffer;

  // 4800 samples @ 48kHz = 100ms
  it("lets one fade fill the buffer when the other is disabled", () => {
    const out = trimAudioBuffer(ctx, dc(4800), 0, 4800, { in: 0, out: 100 }).getChannelData(0);
    expect(out[0]).toBe(1);
    expect(out[2400]).toBeCloseTo(0.5, 2);
    expect(out[4799]).toBeLessThan(0.01);
  });

  it("allows two fades that exactly abut", () => {
    const out = trimAudioBuffer(ctx, dc(4800), 0, 4800, { in: 50, out: 50 }).getChannelData(0);
    expect(out[0]).toBe(0);
    expect(out[2400]).toBe(1);
    expect(out[4799]).toBeLessThan(0.01);
  });

  it("drops a fade longer than the buffer instead of indexing before 0", () => {
    const out = trimAudioBuffer(ctx, dc(4800), 0, 4800, { in: 0, out: 200 }).getChannelData(0);
    expect(Array.from(out).every((v) => v === 1)).toBe(true);
  });
});
