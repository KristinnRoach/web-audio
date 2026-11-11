import { describe, expect, it } from 'vite-plus/test';
import { readHermite, readLinear, readSinc } from '../engine/source-reader.js';

const LENGTH = 4096;
const sine = (cyclesPerSample: number) =>
  Float32Array.from({ length: LENGTH }, (_, i) => Math.sin(2 * Math.PI * cyclesPerSample * i));

// RMS of a read through the middle of the source at `rate`, away from the edges.
function readRms(
  read: (s: Float32Array, p: number, last: number, rate: number) => number,
  source: Float32Array,
  rate: number,
) {
  let sum = 0;
  let count = 0;
  for (let p = 512.37; p < LENGTH - 512; p += rate, count++) {
    sum += read(source, p, LENGTH - 1, rate) ** 2;
  }
  return Math.sqrt(sum / count);
}

describe('source reader', () => {
  it('hits samples exactly at integer positions and follows a ramp between them', () => {
    // Long enough that the sinc kernel doesn't reach the clamped edges.
    const ramp = Float32Array.from({ length: 64 }, (_, i) => i * 0.1);
    for (const read of [readLinear, readHermite, readSinc]) {
      expect(read(ramp, 30, 63, 1)).toBeCloseTo(3, 5);
      expect(read(ramp, 30.25, 63, 1)).toBeCloseTo(3.025, 4);
    }
  });

  it('keeps unity gain at DC for any rate and fractional position', () => {
    const dc = new Float32Array(1024).fill(0.5);
    for (const rate of [0.5, 1, 1.7, 3, 8, 20]) {
      expect(readSinc(dc, 500.31, 1023, rate)).toBeCloseTo(0.5, 6);
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
