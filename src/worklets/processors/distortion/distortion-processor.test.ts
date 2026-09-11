import { describe, it, expect, beforeAll } from "vite-plus/test";

let DistortionProcessor: any;

beforeAll(async () => {
  const g = globalThis as any;
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (_: unknown) => {} };
  };
  g.registerProcessor = (_name: string, ctor: any) => (DistortionProcessor = ctor);
  await import("./distortion-processor.js");
});

const run = (samples: number[], params: Record<string, number>) => {
  const node = new DistortionProcessor();
  const input = [[Float32Array.from(samples)]];
  const output = [[new Float32Array(samples.length)]];
  node.process(input, output, {
    distortionDrive: Float32Array.of(params.distortionDrive ?? 0),
    clippingAmount: Float32Array.of(params.clippingAmount ?? 0),
    clippingThreshold: Float32Array.of(params.clippingThreshold ?? 0.5),
  });
  return Array.from(output[0][0]);
};

describe("distortion-processor", () => {
  it("passes hot signal through untouched when the effect is off", () => {
    const hot = [1.4, -1.4, 0.999, 2.0];
    // float32 round-trip, so compare per sample rather than exactly
    run(hot, {}).forEach((s, i) => expect(s).toBeCloseTo(hot[i], 6));
  });

  it("does not pin peaks to 0.999 as input crosses 0 dBFS", () => {
    // The bug in #55: every sample above 1.0 came back as exactly 0.999.
    const out = run([1.05, 1.5, 3.0], {});
    expect(out.every((s) => s > 1.0)).toBe(true);
  });

  it("still clips when clipping is actually engaged", () => {
    const out = run([1.0], { clippingAmount: 1, clippingThreshold: 0.25 });
    expect(out[0]).toBeCloseTo(0.25);
  });

  it("declares a non-zero minimum clipping threshold so it cannot divide by zero", () => {
    const threshold = DistortionProcessor.parameterDescriptors.find(
      (d: any) => d.name === "clippingThreshold",
    );
    expect(threshold.minValue).toBeGreaterThan(0);
  });

  it("produces finite output at the minimum allowed threshold", () => {
    const min = DistortionProcessor.parameterDescriptors.find(
      (d: any) => d.name === "clippingThreshold",
    ).minValue;
    const out = run([0.5, -0.5], { clippingAmount: 1, clippingThreshold: min });
    expect(out.every(Number.isFinite)).toBe(true);
  });
});
