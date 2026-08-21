import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { preProcessAudioBuffer, type PreProcessOptions } from "../Preprocessor";

describe("Preprocessor explicit compression settings", () => {
  let ctx: AudioContext;

  beforeEach(() => {
    ctx = new AudioContext();
  });

  afterEach(async () => {
    if (ctx && ctx.state !== "closed") await ctx.close();
    ctx = null as any;
  });

  // Steady sine: crest factor ~1.41, well below shouldCompress()'s 5.5 threshold,
  // so the analysis alone would always skip compression.
  function steadySine(peak = 0.8): AudioBuffer {
    const length = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = peak * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
    }
    return buffer;
  }

  function peakOf(buffer: AudioBuffer) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
    return peak;
  }

  const baseOptions = {
    normalize: { enabled: false },
    trimSilence: { enabled: false },
    fadeInOutMs: 0,
    tune: { detectPitch: false, autotune: false },
    hpf: { cutoff: 20 },
    getZeroCrossings: false,
  };

  async function peakWith(compress: NonNullable<PreProcessOptions["compress"]>) {
    const { audiobuffer } = await preProcessAudioBuffer(ctx, steadySine(), {
      ...baseOptions,
      compress,
    });
    return peakOf(audiobuffer);
  }

  it("compresses when settings are given, even if the analysis would skip", async () => {
    const off = await peakWith({ enabled: false });
    const auto = await peakWith({ enabled: true });
    const manual = await peakWith({ enabled: true, threshold: 0.2, ratio: 8 });

    // Analysis-only path decides not to compress this sine, so it matches compression off
    expect(auto).toBeCloseTo(off, 4);
    // Explicit settings apply regardless: 0.2 + (peak - 0.2) / 8
    expect(manual).toBeCloseTo(0.2 + (off - 0.2) / 8, 3);

    // Any one of the three counts as manual; the other two fall back to defaults
    const gainOnly = await peakWith({ enabled: true, makeupGain: 1 });
    expect(gainOnly).toBeCloseTo(0.5 + (off - 0.5) / 2, 3);
  });
});
