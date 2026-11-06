import { describe, expect, it } from 'vite-plus/test';
import { detectPitchPeriods } from '../pitchPeriods';

const RATE = 48_000;

function tone(frequency: number, partials: [harmonic: number, gain: number][], seconds = 0.5) {
  return Float32Array.from(
    { length: RATE * seconds },
    (_, i) =>
      partials.reduce(
        (sum, [harmonic, gain]) =>
          sum + gain * Math.sin((2 * Math.PI * frequency * harmonic * i) / RATE),
        0,
      ) * 0.3,
  );
}

describe('detectPitchPeriods', () => {
  it.each([
    ['a sine', [[1, 1]]],
    [
      'several rising crossings per cycle',
      [
        [1, 0.3],
        [3, 1],
        [5, 0.7],
      ],
    ],
  ] as [string, [number, number][]][])('finds the true period of %s', (_name, partials) => {
    const { periods, hopSamples } = detectPitchPeriods(tone(220, partials), RATE);
    expect(hopSamples).toBe(480);
    for (const period of periods) expect(period).toBeCloseTo(RATE / 220, 0);
  });

  it('follows a note change', () => {
    const samples = new Float32Array(RATE);
    samples.set(tone(220, [[1, 1]]), 0);
    samples.set(tone(440, [[1, 1]]), RATE / 2);
    const { periods } = detectPitchPeriods(samples, RATE);
    expect(periods[10]).toBeCloseTo(RATE / 220, 0);
    expect(periods[90]).toBeCloseTo(RATE / 440, 0);
  });

  it('reports no pitch for silence or audio shorter than a window', () => {
    expect(detectPitchPeriods(new Float32Array(RATE / 4), RATE).periods.some(Boolean)).toBe(false);
    expect(detectPitchPeriods(new Float32Array(100), RATE).periods.some(Boolean)).toBe(false);
  });

  it('reports little pitch in noise', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: RATE / 2 }, () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647 - 0.5;
    });
    const { periods } = detectPitchPeriods(noise, RATE);
    expect(periods.filter(Boolean).length / periods.length).toBeLessThan(0.1);
  });
});
