import { afterEach, expect, it, vi } from 'vite-plus/test';
import type { SampleVoicePool } from './SampleVoicePool';

vi.mock('@/nodes/params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MacroParam: class {
    setValue() {}
    dispose() {}
  },
}));
vi.mock('@/nodes/preprocessor/Preprocessor', () => ({
  preProcessAudioBuffer: vi.fn(async (_context, buffer) => ({ audiobuffer: buffer })),
}));
vi.mock('@/utils/audiodata/convert/resampleAudioBuffer', () => ({
  resampleAudioBuffer: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('skips later resampling failures, rejects sample 0 failures, and permits retry', async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal(
    'GainNode',
    class {
      disconnect() {}
    },
  );
  const { SamplePlayer } = await import('./SamplePlayer');
  const { resampleAudioBuffer } =
    await import('../../../utils/audiodata/convert/resampleAudioBuffer');
  const context = Object.assign(new EventTarget(), { sampleRate: 48000 });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });
  const first = {
    duration: 1,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array([0.5]),
  };
  const laterData = { ...first, sampleRate: 44100 };
  const firstBuffer = first as unknown as AudioBuffer;
  const later = laterData as unknown as AudioBuffer;
  const failure = new Error('Rendering failed');
  vi.mocked(resampleAudioBuffer).mockImplementation(async (buffer) => {
    if (buffer === later) throw failure;
    return buffer;
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let loaded = () => {};
  const publish = vi.fn(() => loaded());
  player.voicePool = {
    onMessage: (_type: string, callback: () => void) => {
      loaded = callback;
      return () => {};
    },
    setAudioData: publish,
    applyToAllVoices: vi.fn(),
    dispose: vi.fn(),
  } as unknown as SampleVoicePool;
  vi.spyOn(player, 'releaseAll').mockReturnValue(player);
  vi.spyOn(player, 'setScale').mockReturnValue(player);

  try {
    await expect(player.loadAudio([firstBuffer, later])).resolves.toEqual([firstBuffer]);
    expect(publish).toHaveBeenCalledWith([firstBuffer], []);
    expect(player.samples).toEqual([firstBuffer]);
    expect(warn).toHaveBeenCalledWith('Failed to resample sample 1; skipping', failure);

    publish.mockClear();
    await expect(player.loadAudio([later, firstBuffer])).rejects.toThrow(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(player.samples).toEqual([firstBuffer]);
    await expect(player.loadAudio(firstBuffer)).resolves.toEqual([firstBuffer]);
  } finally {
    player.dispose();
  }
});
