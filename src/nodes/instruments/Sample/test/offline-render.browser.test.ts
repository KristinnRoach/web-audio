import { describe, expect, it, vi } from 'vite-plus/test';
import { getAllNodeIds } from '@/nodes/node-store';
import { createSamplePlayer } from '../createSamplePlayer';

const peak = (data: Float32Array) => data.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

describe('SamplePlayer on an OfflineAudioContext', () => {
  it('renders a scheduled note and releases the player once disposed', async () => {
    const sampleRate = 48000;
    const registered = getAllNodeIds().length;
    const error = vi.spyOn(console, 'error');
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sampleRate, sampleRate });
    const audio = ctx.createBuffer(1, sampleRate, sampleRate);
    audio.getChannelData(0).forEach((_, i, data) => {
      data[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5;
    });

    const player = await createSamplePlayer({ context: ctx, audio });
    // Send while rendering is suspended at 0, as the README shows, so the message
    // reaches the worklet before the first frame.
    void ctx.suspend(0).then(() => {
      player.play(60, 100, 0, 0.5);
      void ctx.resume();
    });
    const rendered = await ctx.startRendering();

    const data = rendered.getChannelData(0);
    expect(peak(data.subarray(0, 0.45 * sampleRate))).toBe(0);
    expect(peak(data.subarray(0.5 * sampleRate))).toBeGreaterThan(0.01);

    player.dispose();
    expect(getAllNodeIds()).toHaveLength(registered);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
