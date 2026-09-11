import { describe, it, expect, beforeAll } from "vite-plus/test";

let MeterProcessor: any;

beforeAll(async () => {
  const g = globalThis as any;
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (_: unknown) => {} };
  };
  g.registerProcessor = (_name: string, ctor: any) => (MeterProcessor = ctor);
  await import("./level-meter-processor.js");
});

const run = (blocks: number[][], processorOptions = {}) => {
  const reports: any[] = [];
  const meter = new MeterProcessor({ processorOptions });
  meter.port = { postMessage: (data: any) => reports.push(data) };
  for (const block of blocks) meter.process([[Float32Array.from(block)]]);
  return reports;
};

describe("level-meter-processor", () => {
  const blockOf = (value: number) => Array.from({ length: 128 }, () => value);
  // 48000 samples/s * 0.1s = 4800 samples = 37.5 blocks of 128
  const blocksPerReport = 38;

  it("reports peak and rms of the window", () => {
    const reports = run(Array.from({ length: blocksPerReport }, () => blockOf(0.5)));
    expect(reports).toHaveLength(1);
    expect(reports[0].peak).toBeCloseTo(0.5);
    expect(reports[0].rms).toBeCloseTo(0.5);
  });

  it("counts every clipped sample, not just the ones near a report boundary", () => {
    const clipping = blockOf(1.5);
    const blocks = Array.from({ length: blocksPerReport }, (_, i) =>
      i === 0 ? clipping : blockOf(0),
    );
    const reports = run(blocks);
    expect(reports[0].clipCount).toBe(128);
    expect(reports[0].peak).toBeCloseTo(1.5);
  });

  it("carries clipCount across windows while peak resets", () => {
    const blocks = [
      ...Array.from({ length: blocksPerReport }, () => blockOf(1.5)),
      ...Array.from({ length: blocksPerReport }, () => blockOf(0.1)),
    ];
    const reports = run(blocks);
    expect(reports).toHaveLength(2);
    expect(reports[0].clipCount).toBeGreaterThan(0);
    expect(reports[1].clipCount).toBe(reports[0].clipCount);
    expect(reports[1].peak).toBeCloseTo(0.1);
  });

  it("reports on frames, not channel samples, so stereo keeps the same interval", () => {
    const reports: any[] = [];
    const meter = new MeterProcessor({ processorOptions: {} });
    meter.port = { postMessage: (data: any) => reports.push(data) };
    const stereoBlock = () => [Float32Array.from(blockOf(0.5)), Float32Array.from(blockOf(0.5))];
    for (let i = 0; i < blocksPerReport - 1; i++) meter.process([stereoBlock()]);
    expect(reports).toHaveLength(0);
    meter.process([stereoBlock()]);
    expect(reports).toHaveLength(1);
    expect(reports[0].rms).toBeCloseTo(0.5);
  });

  it("survives a disconnected input", () => {
    const meter = new MeterProcessor({});
    expect(meter.process([[]])).toBe(true);
    expect(meter.process([])).toBe(true);
  });
});
