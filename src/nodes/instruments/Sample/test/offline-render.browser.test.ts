import { describe, expect, it } from 'vite-plus/test';
import { renderOffline } from '@/context';
import { createSamplePlayer } from '../createSamplePlayer';

const peak = (data: Float32Array) => data.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

describe('renderOffline', () => {
  it('renders SamplePlayer notes scheduled from setup', async () => {
    const sampleRate = 48000;
    const rendered = await renderOffline(
      async (ctx) => {
        const audio = ctx.createBuffer(1, sampleRate, sampleRate);
        audio.getChannelData(0).forEach((_, i, data) => {
          data[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5;
        });
        const player = await createSamplePlayer({ context: ctx, audio });
        player.play(60, 100, 0, 0.5);
      },
      { duration: 1, sampleRate },
    );

    const data = rendered.getChannelData(0);
    expect(peak(data.subarray(0, 0.45 * sampleRate))).toBe(0);
    expect(peak(data.subarray(0.5 * sampleRate))).toBeGreaterThan(0.01);
  });

  it('rejects with the setup error', async () => {
    await expect(
      renderOffline(
        () => {
          throw new Error('boom');
        },
        { duration: 0.01 },
      ),
    ).rejects.toThrow('boom');
  });
});
