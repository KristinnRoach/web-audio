import { describe, expect, it, vi } from 'vite-plus/test';
import { createColoredNoise, createPulseWave } from './generateWaveform';

function captureWave() {
  const createPeriodicWave = vi.fn(
    (_real: Float32Array, _imag: Float32Array, _options: PeriodicWaveConstraints) =>
      ({}) as PeriodicWave,
  );
  return {
    context: { createPeriodicWave } as unknown as AudioContext,
    coefficients: () => createPeriodicWave.mock.calls[0],
  };
}

describe('custom waveform spectra', () => {
  it('makes the default pulse square away from its transitions', () => {
    const wave = captureWave();
    createPulseWave(wave.context, { harmonics: 128 });
    const [real, imag] = wave.coefficients();
    const at = (phase: number) =>
      real.reduce(
        (sum, coefficient, n) =>
          sum + coefficient * Math.cos(n * phase) + imag[n] * Math.sin(n * phase),
        0,
      );

    // Normalization can scale the wave, but its two plateaus must stay flat.
    for (const phase of [0.2, 0.6, 1]) expect(Math.abs(at(phase) - at(0))).toBeLessThan(0.01);
    for (const phase of [2, 2.6, Math.PI]) expect(Math.abs(at(phase) + at(0))).toBeLessThan(0.01);
  });

  it('attenuates high harmonics for negative slopes and boosts them for positive slopes', () => {
    for (const slope of [-1, 1]) {
      const wave = captureWave();
      createColoredNoise(wave.context, { slope, harmonics: 16, seed: 1 });
      const [real, imag] = wave.coefficients();
      const power = (n: number) => real[n] ** 2 + imag[n] ** 2;

      expect(Math.sign(power(8) - power(1))).toBe(slope);
    }
  });
});
