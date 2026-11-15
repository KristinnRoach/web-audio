import { describe, expect, it, vi } from 'vite-plus/test';
import { renderOffline } from '@/context';
import { getAllNodeIds } from '@/nodes/node-store';
import { createSamplePlayer } from '../createSamplePlayer';
import type { SamplePlayer } from '../SamplePlayer';

const peak = (data: Float32Array) => data.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

describe('renderOffline', () => {
  it('renders scheduled SamplePlayer notes and releases the player once disposed', async () => {
    const sampleRate = 48000;
    const registered = getAllNodeIds().length;
    const error = vi.spyOn(console, 'error');
    let player: SamplePlayer | undefined;
    try {
      const rendered = await renderOffline(
        async (ctx) => {
          const audio = ctx.createBuffer(1, sampleRate, sampleRate);
          audio.getChannelData(0).forEach((_, i, data) => {
            data[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5;
          });
          player = await createSamplePlayer({ context: ctx, audio });
          player.play(60, 100, 0, 0.5);
        },
        { duration: 1, sampleRate },
      );

      const data = rendered.getChannelData(0);
      expect(peak(data.subarray(0, 0.45 * sampleRate))).toBe(0);
      expect(peak(data.subarray(0.5 * sampleRate))).toBeGreaterThan(0.01);
      expect(getAllNodeIds().length).toBeGreaterThan(registered);
    } finally {
      player?.dispose();
    }

    expect(getAllNodeIds()).toHaveLength(registered);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
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
