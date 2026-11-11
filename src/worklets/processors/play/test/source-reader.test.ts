import { describe, expect, it } from 'vite-plus/test';
import { ClampedSourceReader, type SourceReader } from '../engine/source-reader.js';
import { readHermite, readLinear, readSinc } from '../engine/interpolation-kernels.js';

const LENGTH = 4096;
const sine = (cyclesPerSample: number) =>
  Float32Array.from({ length: LENGTH }, (_, i) => Math.sin(2 * Math.PI * cyclesPerSample * i));

// RMS of a read through the middle of the source at `rate`, away from the edges.
function readRms(
  read: (s: SourceReader, p: number, rate: number) => number,
  source: Float32Array,
  rate: number,
) {
  const reader = new ClampedSourceReader(source);
  let sum = 0;
  let count = 0;
  for (let p = 512.37; p < LENGTH - 512; p += rate, count++) {
    sum += read(reader, p, rate) ** 2;
  }
  return Math.sqrt(sum / count);
}

describe('source reader', () => {
  it('repeats the endpoints of the head’s inclusive sample range', () => {
    const source = new ClampedSourceReader(new Float32Array([2, 4, 8, 16]), 2);
    expect([-100, -1, 0, 1, 2, 3, 100].map((index) => source.readTap(index))).toEqual([
      2, 2, 2, 4, 8, 8, 8,
    ]);
  });

  it('returns silence for empty sources and repeats a single sample', () => {
    for (const samples of [null, new Float32Array(), new Float32Array([0.5])]) {
      const source = new ClampedSourceReader(samples);
      for (const index of [-100, 0, 100]) {
        expect(source.readTap(index)).toBe(samples?.length ? 0.5 : 0);
      }
    }
  });

  it('keeps head bounds independent while reusing a reader across channels', () => {
    const samples = new Float32Array([1, 2, 3, 4]);
    const outgoing = new ClampedSourceReader(samples, 2);
    const current = new ClampedSourceReader(samples, 3);
    current.lastIndex = 1;
    expect(outgoing.readTap(10)).toBe(3);
    expect(current.readTap(10)).toBe(2);
    outgoing.samples = new Float32Array([5, 6, 7, 8]);
    expect(outgoing.readTap(10)).toBe(7);
    expect(current.readTap(10)).toBe(2);
  });

  it('lets the source define continuation for every kernel', () => {
    // An unbounded ramp proves the kernels do not clamp taps to array bounds.
    const source: SourceReader = { readTap: (index) => index * 0.1 };
    for (const read of [readLinear, readHermite, readSinc]) {
      expect(read(source, -0.25, 1)).toBeCloseTo(-0.025, 4);
    }
  });

  it('hits samples exactly at integer positions and follows a ramp between them', () => {
    // Long enough that the sinc kernel doesn't reach the clamped edges.
    const ramp = Float32Array.from({ length: 64 }, (_, i) => i * 0.1);
    for (const read of [readLinear, readHermite, readSinc]) {
      expect(read(new ClampedSourceReader(ramp), 30, 1)).toBeCloseTo(3, 5);
      expect(read(new ClampedSourceReader(ramp), 30.25, 1)).toBeCloseTo(3.025, 4);
    }
  });

  it('keeps unity gain at DC for any rate and fractional position', () => {
    const dc = new Float32Array(1024).fill(0.5);
    for (const rate of [0.5, 1, 1.7, 3, 8, 20]) {
      expect(readSinc(new ClampedSourceReader(dc), 500.31, rate)).toBeCloseTo(0.5, 6);
    }
  });

  it('passes content below the lowered Nyquist frequency when pitching up', () => {
    // 0.05 cycles/sample at rate 4 sounds at 0.2: below the output Nyquist frequency.
    expect(readRms(readSinc, sine(0.05), 4)).toBeGreaterThan(0.69);
  });

  it('removes content that would fold back when pitching up', () => {
    // 0.3 cycles/sample at rate 2 sounds at 0.6, folding back to 0.4.
    const source = sine(0.3);
    expect(readRms(readLinear, source, 2)).toBeGreaterThan(0.3);
    expect(readRms(readSinc, source, 2)).toBeLessThan(0.01);
  });
});
