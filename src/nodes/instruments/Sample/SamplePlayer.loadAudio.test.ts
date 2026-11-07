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

it('loads one buffer, preserves it on failure, and permits retry', async () => {
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
  let loaded = () => {};
  const publish = vi.fn(() => loaded());
  const setLoopEnabled = vi.fn();
  await initTestPlayer(player, {
    allVoices: [{ setLoopEnabled }],
    onMessage: (_type: string, callback: () => void) => {
      loaded = callback;
      return () => {};
    },
    setBuffer: publish,
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
    await expect(player.loadAudio(firstBuffer)).resolves.toBe(firstBuffer);
    expect(publish).toHaveBeenCalledWith(firstBuffer, []);
    expect(player.audiobuffer).toBe(firstBuffer);
    player.setLoopEnabled(true);
    expect(setLoopEnabled).toHaveBeenCalledWith(true);
    expect(loopChanged).not.toHaveBeenCalled();
    player.setLoopLocked(true);
    setLoopEnabled.mockClear();
    player.setLoopEnabled(false);
    expect(setLoopEnabled).not.toHaveBeenCalled();
    expect(player.loopEnabled).toBe(true);
    expect(loopChanged).not.toHaveBeenCalled();

    publish.mockClear();
    await expect(player.loadAudio(later)).rejects.toThrow(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(player.audiobuffer).toBe(firstBuffer);
    await expect(player.loadAudio(firstBuffer)).resolves.toBe(firstBuffer);

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
    const original = createBuffer(1, 480, 48000);
    original.getChannelData(0).fill(0.5);
    original.getChannelData(0)[400] = 1;
    vi.mocked(resampleAudioBuffer).mockImplementation(async (buffer) => buffer);
    await player.loadAudio(original);
    // Ratios follow the loaded sample's duration.
    player.updateEnvelope('amp', { duration: 0.3 });
    player.updateEnvelope('amp', { durationRatio: 1 });
    expect(player.getEnvelopeDuration('amp')).toBe(original.duration);
    expect(player.getEnvelope('amp').shape.points.at(-1)?.time).toBe(original.duration);
    // commitPitch bakes the summed offset and zeroes it
    const committed = vi.fn();
    player.onMessage('pitch:committed', committed);
    await expect(player.commitPitch()).resolves.toBeNull();
    player.transpose(-12);
    await player.commitPitch();
    expect(player.audiobuffer?.length).toBe(960);
    // The sinc filter slightly attenuates a one-frame marker, but keeps its position.
    expect(player.audiobuffer!.getChannelData(0)[800]).toBeGreaterThan(0.9);
    expect(player.audiobuffer!.getChannelData(0)[700]).toBeCloseTo(0.5, 4);
    expect(player.transposedBySemitones).toBe(0);
    expect(committed).toHaveBeenCalledTimes(1);
    // A transpose during the reload survives as a delta on the baked audio
    player.transpose(12);
    const pending = player.commitPitch();
    player.transpose(14);
    await pending;
    expect(player.transposedBySemitones).toBe(2);
    player.transpose(0);
    expect(player.audiobuffer?.length).toBe(480);
    // Band-limited resampling isn't bit-exact over a round trip; crop the originals.
    await player.loadAudio(original);
    // Inverted points crop the same 0.002..0.006 region
    const cropped = await player.cropSample(0.006, 0.002, { in: 0, out: 0 });
    expect(cropped).toBe(player.audiobuffer!);
    expect(player.audiobuffer?.length).toBe(192);
    expect(Array.from(player.audiobuffer!.getChannelData(0))).toEqual(Array(192).fill(0.5));
    // A silent crop is still a valid reload.
    original.getChannelData(0).fill(0, 0, 300);
    await player.loadAudio(original);
    await player.cropSample(0, 0.004, { in: 0, out: 0 });
    expect(player.audiobuffer?.length).toBe(192);
    expect(player.audiobuffer?.getChannelData(0).every((sample) => sample === 0)).toBe(true);
  } finally {
    player.dispose();
  }
});

it('sends pitch periods once per load, only in period mode', async () => {
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
  vi.mocked(resampleAudioBuffer).mockImplementation(async (buffer) => buffer);
  const context = Object.assign(new EventTarget(), { sampleRate: 48000, currentTime: 0 });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });
  const buffer = {
    duration: 1,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array(48000).fill(0.5),
  } as unknown as AudioBuffer;
  let loaded = () => {};
  const setPitchPeriods = vi.fn();
  // Init and load configure voices in other ways too; only this call matters here.
  const voice = new Proxy({ setPitchPeriods } as Record<string | symbol, unknown>, {
    get: (target, key) => target[key] ?? (() => {}),
  });
  await initTestPlayer(player, {
    allVoices: [],
    onMessage: (_type: string, callback: () => void) => {
      loaded = callback;
      return () => {};
    },
    setBuffer: vi.fn(() => loaded()),
    applyToAllVoices: (fn: (voice: never) => void) => fn(voice as never),
    dispose: vi.fn(),
  } as unknown as Partial<SampleVoicePool>);
  vi.spyOn(player, 'releaseAll').mockReturnValue(player);

  // Choosing the mode before any audio has nothing to detect yet.
  player.setTimestretchMode('period');
  expect(setPitchPeriods).not.toHaveBeenCalled();
  await player.loadAudio(buffer);
  expect(setPitchPeriods).toHaveBeenCalledTimes(1);

  // Switching back to the mode reuses what the voices already hold.
  player.setTimestretchMode('off');
  player.setTimestretchMode('period');
  expect(setPitchPeriods).toHaveBeenCalledTimes(1);

  // Voices clear periods on every load, even of the same buffer.
  await player.loadAudio(buffer);
  expect(setPitchPeriods).toHaveBeenCalledTimes(2);

  player.setTimestretchMode('off');
  await player.loadAudio(buffer);
  expect(setPitchPeriods).toHaveBeenCalledTimes(2);
  player.setTimestretchMode('period');
  expect(setPitchPeriods).toHaveBeenCalledTimes(3);
});
