import { initTestPlayer } from './test/initTestPlayer';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import type { SampleVoicePool } from './SampleVoicePool';

vi.mock('@/nodes/params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MacroParam: class {
    setValue() {}
    dispose() {}
  },
}));
vi.mock('@/nodes/preprocessor/Preprocessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
      connect() {}
      disconnect() {}
    },
  );
  const { SamplePlayer } = await import('./SamplePlayer');
  const { resampleAudioBuffer } =
    await import('../../../utils/audiodata/convert/resampleAudioBuffer');
  const context = Object.assign(new EventTarget(), { sampleRate: 48000, currentTime: 0 });
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
  const setLoopEnabled = vi.fn();
  await initTestPlayer(player, {
    allVoices: [{ setLoopEnabled }],
    onMessage: (_type: string, callback: () => void) => {
      loaded = callback;
      return () => {};
    },
    setAudioData: publish,
    applyToAllVoices: vi.fn(),
    dispose: vi.fn(),
  } as unknown as Partial<SampleVoicePool>);
  vi.spyOn(player, 'releaseAll').mockReturnValue(player);

  try {
    const loopChanged = vi.fn();
    player.onMessage('loop:enabled', loopChanged);
    player.setLoopEnabled(true);
    setLoopEnabled.mockClear();
    loopChanged.mockClear();
    await expect(player.loadAudio([firstBuffer, later])).resolves.toEqual([firstBuffer]);
    expect(publish).toHaveBeenCalledWith([firstBuffer], []);
    expect(player.samples).toEqual([firstBuffer]);
    player.setLoopEnabled(true);
    expect(setLoopEnabled).toHaveBeenCalledWith(true);
    expect(loopChanged).not.toHaveBeenCalled();
    player.setLoopLocked(true);
    setLoopEnabled.mockClear();
    player.setLoopEnabled(false);
    expect(setLoopEnabled).not.toHaveBeenCalled();
    expect(player.loopEnabled).toBe(true);
    expect(loopChanged).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Failed to resample sample 1; skipping', failure);

    publish.mockClear();
    await expect(player.loadAudio([later, firstBuffer])).rejects.toThrow(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(player.samples).toEqual([firstBuffer]);
    await expect(player.loadAudio(firstBuffer)).resolves.toEqual([firstBuffer]);

    // Scrolling preserves the signed length and keeps both points inside the sample.
    for (const [start, end, requested, expectedStart, expectedEnd] of [
      [0.8, 0.2, 0, 0.6, 0],
      [0.8, 0.2, 2, 1, 0.4],
      [0.2, 0.8, -1, 0, 0.6],
      [0.2, 0.8, 2, 0.4, 1],
    ]) {
      player.setLoopStart(start);
      player.setLoopEnd(end);
      player.scrollLoopPoints(requested);
      expect(player.loopStart).toBeCloseTo(expectedStart);
      expect(player.loopEnd).toBeCloseTo(expectedEnd);
      expect(player.loopEnd - player.loopStart).toBeCloseTo(end - start);
    }

    // Crop actual PCM through the existing loader harness, including silence.
    const createBuffer = (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return {
        length,
        sampleRate,
        numberOfChannels: 1,
        duration: length / sampleRate,
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    };
    Object.assign(context, { createBuffer });
    const originals = [480, 120, 48].map((length) => {
      const buffer = createBuffer(1, length, 48000);
      buffer.getChannelData(0).fill(0.5);
      return buffer;
    });
    vi.mocked(resampleAudioBuffer).mockImplementation(async (buffer) => buffer);
    await player.loadAudio(originals);
    // commitPitch bakes the summed offset and zeroes it
    const committed = vi.fn();
    player.onMessage('pitch:committed', committed);
    await expect(player.commitPitch()).resolves.toBeNull();
    player.transpose(-12);
    await player.commitPitch();
    expect(player.samples.map((buffer) => buffer.length)).toEqual([960, 240, 96]);
    expect(player.transposedBySemitones).toBe(0);
    expect(committed).toHaveBeenCalledTimes(1);
    // A transpose during the reload survives as a delta on the baked audio
    player.transpose(12);
    const pending = player.commitPitch();
    player.transpose(14);
    await pending;
    expect(player.transposedBySemitones).toBe(2);
    player.transpose(0);
    expect(player.samples.map((buffer) => buffer.length)).toEqual([480, 120, 48]);
    // Band-limited resampling isn't bit-exact over a round trip; crop the originals.
    await player.loadAudio(originals);
    // Inverted points crop the same 0.002..0.006 region
    const cropped = await player.cropSample(0.006, 0.002, { in: 0, out: 0 });
    expect(cropped).toBe(player.samples[0]);
    expect(player.samples.map((buffer) => buffer.length)).toEqual([192, 192, 192]);
    expect(Array.from(player.samples[0].getChannelData(0))).toEqual(Array(192).fill(0.5));
    expect(Array.from(player.samples[1].getChannelData(0))).toEqual([
      ...Array(24).fill(0.5),
      ...Array(168).fill(0),
    ]);
    expect(Array.from(player.samples[2].getChannelData(0))).toEqual(Array(192).fill(0));
  } finally {
    player.dispose();
  }
});
