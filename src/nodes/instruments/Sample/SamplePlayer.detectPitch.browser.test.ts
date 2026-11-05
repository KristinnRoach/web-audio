import { expect, test } from 'vite-plus/test';
import { preProcessAudioBuffer } from '@/nodes/preprocessor/Preprocessor';
import { SamplePlayer } from './SamplePlayer';

test('detectPitch matches what autotune measures and leaves the sample alone', async () => {
  const context = new AudioContext();
  await context.audioWorklet.addModule('/dist/processors/processors.js');
  const player = new SamplePlayer({ context, polyphony: 1, voiceSignalChain: [] });
  await player.init();

  try {
    await expect(player.detectPitch()).resolves.toBeNull();

    const hz = 220 * 2 ** (1.3 / 12); // 130 cents above A3, so not already on a note
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / context.sampleRate);
    }
    const loaded = await player.loadAudio(buffer, { skipPreProcessing: true });
    const before = loaded!.getChannelData(0).slice();

    const pitch = await player.detectPitch();
    const autotune = await preProcessAudioBuffer(context, buffer);

    expect(pitch!.frequency).toBe(autotune.detectedPitch!.fundamentalHz);
    expect(pitch!.periodicity).toBe(autotune.detectedPitch!.periodicity);
    expect(Math.abs(1200 * Math.log2(pitch!.frequency / hz))).toBeLessThan(5);
    expect(pitch!.midiFloat).toBeCloseTo(58.3, 1);
    expect(pitch!.periodicity).toBeGreaterThan(0.9);
    expect(player.audiobuffer).toBe(loaded);
    expect(player.audiobuffer!.getChannelData(0)).toEqual(before);
  } finally {
    player.dispose();
    await context.close();
  }
});
