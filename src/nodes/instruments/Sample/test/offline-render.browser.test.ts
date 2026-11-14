import { describe, expect, it } from 'vite-plus/test';
import { createSamplePlayer } from '../createSamplePlayer';

describe('SamplePlayer on an OfflineAudioContext', () => {
  it('renders a played note', async () => {
    const sampleRate = 48000;
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sampleRate, sampleRate });
    const audio = ctx.createBuffer(1, sampleRate, sampleRate);
    audio.getChannelData(0).forEach((_, i, data) => {
      data[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5;
    });

    const player = await createSamplePlayer({ context: ctx, audio });
    // Play while rendering is suspended, so the voice message reaches the worklet first.
    void ctx.suspend(0.1).then(() => {
      player.play(60);
      void ctx.resume();
    });
    const rendered = await ctx.startRendering();

    const peak = rendered.getChannelData(0).reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.01);
  });
});
