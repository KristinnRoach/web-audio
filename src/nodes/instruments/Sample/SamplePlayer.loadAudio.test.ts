import { initTestPlayer } from './test/initTestPlayer';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import type { SamplePlayer } from './SamplePlayer';

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

/** Answers each buffer the way the processor does: one `voice:loaded` per voice. */
async function initLoadingPlayer(player: SamplePlayer, voiceCount: number) {
  const test = await initTestPlayer(player, {
    onPost: (message) => {
      if (message.type !== 'voice:setBuffer') return;
      for (let voice = 0; voice < voiceCount; voice++) {
        test.report({ type: 'voice:loaded', voice, durationSeconds: message.durationSeconds });
      }
    },
  });
  return test;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['resampling', 'preprocessing', 'processor acknowledgement'])(
  'rejects a load disposed during %s without restoring the sample',
  async (stage) => {
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
    const { preProcessAudioBuffer } = await import('../../preprocessor/Preprocessor');
    let markEntered!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pause = async () => {
      markEntered();
      await paused;
    };
    vi.mocked(resampleAudioBuffer).mockImplementation(async (buffer) => {
      if (stage === 'resampling') await pause();
      return buffer;
    });
    vi.mocked(preProcessAudioBuffer).mockImplementation(async (_context, buffer) => {
      if (stage === 'preprocessing') await pause();
      return { audiobuffer: buffer };
    });
    const context = Object.assign(new EventTarget(), { sampleRate: 48000, currentTime: 0 });
    const player = new SamplePlayer({ context: context as unknown as AudioContext });
    // The processor never acknowledges, so the load waits for it.
    const { ofType } = await initTestPlayer(player, {
      onPost: (message) => message.type === 'voice:setBuffer' && markEntered(),
    });
    const buffer = {
      length: 1,
      duration: 1,
      numberOfChannels: 1,
      sampleRate: 48000,
      getChannelData: () => new Float32Array([0.5]),
      copyFromChannel: (destination: Float32Array) => destination.set(new Float32Array([0.5])),
    } as unknown as AudioBuffer;

    const loading = player.loadAudio(buffer);
    const rejected = expect(loading).rejects.toThrow('SamplePlayer is disposed');
    await entered;
    player.dispose();
    resume();
    await rejected;
    expect(player.audiobuffer).toBeNull();
    expect(player.isLoaded).toBe(false);
    expect(ofType('voice:setBuffer')).toHaveLength(stage === 'processor acknowledgement' ? 1 : 0);
    await expect(player.loadAudio(buffer)).rejects.toThrow('SamplePlayer is disposed');
  },
);

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
  const player = new SamplePlayer({ context: context as unknown as AudioContext, polyphony: 2 });
  const first = {
    length: 1,
    duration: 1,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array([0.5]),
    copyFromChannel: (destination: Float32Array) => destination.set(new Float32Array([0.5])),
  };
  const firstBuffer = first as unknown as AudioBuffer;
  const later = { ...first } as unknown as AudioBuffer;
  const mismatched = { ...first, sampleRate: 44100 } as unknown as AudioBuffer;
  const failure = new Error('Rendering failed');
  vi.mocked(resampleAudioBuffer).mockImplementation(async (buffer) => {
    if (buffer === later) throw failure;
    return buffer;
  });
  const { posted, ofType } = await initLoadingPlayer(player, 2);
  const loaded = vi.fn();
  player.onMessage('sample:loaded', loaded);

  try {
    const loopChanged = vi.fn();
    player.onMessage('loop:enabled', loopChanged);
    player.setLoopEnabled(true);
    loopChanged.mockClear();
    posted.length = 0;
    await expect(player.loadAudio(firstBuffer)).resolves.toBe(firstBuffer);
    // One untagged copy for the processor; held notes are released first.
    expect(posted.map((message) => message.type).slice(0, 2)).toEqual([
      'pool:allNotesOff',
      'voice:setBuffer',
    ]);
    expect(ofType('voice:setBuffer')).toEqual([
      { type: 'voice:setBuffer', buffer: [new Float32Array([0.5])], durationSeconds: 1 },
    ]);
    expect(ofType('voice:setZeroCrossings')).toEqual([]);
    // Both voices acknowledged; the player announces the sample once.
    expect(loaded).toHaveBeenCalledOnce();
    expect(player.isLoaded).toBe(true);
    expect(player.audiobuffer).toBe(firstBuffer);
    posted.length = 0;
    player.setLoopEnabled(true);
    expect(ofType('voice:setLoopEnabled')).toEqual([{ type: 'voice:setLoopEnabled', value: true }]);
    expect(loopChanged).not.toHaveBeenCalled();
    player.setLoopLocked(true);
    posted.length = 0;
    player.setLoopEnabled(false);
    expect(ofType('voice:setLoopEnabled')).toEqual([]);
    expect(player.loopEnabled).toBe(true);
    expect(loopChanged).not.toHaveBeenCalled();

    posted.length = 0;
    await expect(player.loadAudio(later)).rejects.toThrow(failure);
    expect(ofType('voice:setBuffer')).toEqual([]);
    expect(player.audiobuffer).toBe(firstBuffer);

    // A buffer at another rate is refused before notes stop or audio is sent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(player.loadAudio(mismatched)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('Sample rate mismatch - buffer: 44100, context: 48000');
    expect(posted).toEqual([]);
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
      player.scrollLoopPosition(requested);
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
        copyFromChannel: (destination: Float32Array, _channel: number, start = 0) =>
          destination.set(data.subarray(start, start + destination.length)),
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
    // Inverted edges crop the same 0.002..0.006 region
    const cropped = await player.cropSample(0.006, 0.002, { in: 0, out: 0 });
    expect(cropped).toBe(player.audiobuffer!);
    expect(player.audiobuffer?.length).toBe(192);
    expect(Array.from(player.audiobuffer!.getChannelData(0))).toEqual(Array(192).fill(0.5));
    // Omitting bounds crops to the current trimStart/trimEnd getters.
    await player.loadAudio(original);
    player.setTrimRange(0.002, 0.006);
    expect(player.trimStart).toBe(0.002);
    expect(player.trimEnd).toBe(0.006);
    await player.cropSample(undefined, undefined, { in: 0, out: 0 });
    expect(player.audiobuffer?.length).toBe(192);
    expect(player.trimStart).toBe(0);
    expect(player.trimEnd).toBe(player.sampleDuration);
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
    length: 48000,
    duration: 1,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array(48000).fill(0.5),
    copyFromChannel: (destination: Float32Array) =>
      destination.set(new Float32Array(48000).fill(0.5)),
  } as unknown as AudioBuffer;
  const { ofType } = await initLoadingPlayer(player, 16);
  const sent = () => ofType('voice:setPitchPeriods').length;

  // Choosing the mode before any audio has nothing to detect yet.
  player.setTimestretchMode('period');
  expect(sent()).toBe(0);
  await player.loadAudio(buffer);
  expect(sent()).toBe(1);

  // Switching back to the mode reuses what the voices already hold.
  player.setTimestretchMode('off');
  player.setTimestretchMode('period');
  expect(sent()).toBe(1);

  // Voices clear periods on every load, even of the same buffer.
  await player.loadAudio(buffer);
  expect(sent()).toBe(2);

  player.setTimestretchMode('off');
  await player.loadAudio(buffer);
  expect(sent()).toBe(2);
  player.setTimestretchMode('period');
  expect(sent()).toBe(3);
});
