import { describe, it, expect } from 'vite-plus/test';
import { resampleAudioBuffer } from './resampleAudioBuffer';

describe('resampleAudioBuffer', () => {
  it('converts length and keeps channels', async () => {
    const input = new AudioBuffer({ numberOfChannels: 2, length: 44_100, sampleRate: 44_100 });
    input.getChannelData(1).fill(0.5);

    const output = await resampleAudioBuffer(input, 48_000);

    expect(output.sampleRate).toBe(48_000);
    expect(output.length).toBe(48_000);
    expect(output.numberOfChannels).toBe(2);
    expect(output.getChannelData(1)[24_000]).toBeCloseTo(0.5, 3);
  });

  it('rejects unsupported rates', async () => {
    const input = new AudioBuffer({ length: 1, sampleRate: 44_100 });
    await expect(resampleAudioBuffer(input, 0)).rejects.toThrow();
  });
});
