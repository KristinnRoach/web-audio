import { expect, it } from 'vite-plus/test';
import { resampleForPitch } from './Preprocessor';

const SR = 48000;

const ctx = {
  createBuffer: (channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      length,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: (channel: number) => data[channel],
    };
  },
} as unknown as AudioContext;

const tone = (hz: number) => {
  const buffer = ctx.createBuffer(1, SR, SR);
  buffer.getChannelData(0).forEach((_, i, data) => {
    data[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  });
  return buffer;
};

// dBFS of `hz` over the middle of the buffer (Hann window).
const level = (buffer: AudioBuffer, hz: number) => {
  const data = buffer.getChannelData(0);
  const n = 16384;
  const start = Math.floor((data.length - n) / 2);
  let re = 0;
  let im = 0;
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const phase = (2 * Math.PI * hz * i) / SR;
    re += data[start + i] * w * Math.cos(phase);
    im += data[start + i] * w * Math.sin(phase);
    windowSum += w;
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / windowSum + 1e-12);
};

it('keeps the passband and rejects aliases and images', () => {
  // Linear interpolation: 15 kHz up an octave aliased to 18 kHz at -6 dBFS.
  expect(level(resampleForPitch(ctx, tone(15000), 12), 18000)).toBeLessThan(-90);
  expect(level(resampleForPitch(ctx, tone(5000), 12), 10000)).toBeCloseTo(-6, 1);
  // Linear interpolation: -2.2 dB droop and a 16.5 kHz image at -19 dBFS.
  const down = resampleForPitch(ctx, tone(15000), -12);
  expect(level(down, 7500)).toBeCloseTo(-6, 1);
  expect(level(down, 16500)).toBeLessThan(-90);
  // Linear interpolation: -2.9 dB on a 30-cent fine-tune commit.
  expect(level(resampleForPitch(ctx, tone(15000), 0.3), 15000 * 2 ** (0.3 / 12))).toBeCloseTo(
    -6,
    1,
  );
});
