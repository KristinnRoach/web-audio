import { initTestPlayer } from './test/initTestPlayer';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { SamplePlayer } from './SamplePlayer';
import type { SampleVoicePool } from './SampleVoicePool';
import type { EnvelopeConfig } from './envelope-config';
import { createDefaultSampleEnvelopeConfig } from './sample-envelope-policy';
import { NOTE_PERIODS } from '../../../utils/music-theory/constants';

const envConfig: EnvelopeConfig = {
  enabled: false,
  timeScale: 2,
  shape: {
    points: [
      { time: 0, value: 0, curve: 'linear' },
      { time: 1, value: 1, curve: 'exponential' },
    ],
    mode: { type: 'once' },
    sustainPoint: 1,
    releasePoint: 1,
  },
};

it('sends loop quantize periods on quantization updates but not on transpose', async () => {
  vi.resetModules();
  vi.doUnmock('@/nodes/params');
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
  const context = Object.assign(new EventTarget(), {
    currentTime: 0,
    createConstantSource: () => ({
      offset: { setValueAtTime() {} },
      start() {},
      stop() {},
      connect() {},
      disconnect() {},
    }),
  });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });
  expect(() => player.setLoopEnabled(false)).not.toThrow();
  const sendToProcessor = vi.fn();
  const setPitchOffset = vi.fn();
  await initTestPlayer(player, {
    applyToAllVoices: (apply) =>
      apply({
        sendToProcessor,
        setPitchOffset,
        getParam: () => null,
        setParam() {},
        setLoopPoints() {},
      } as never),
    dispose() {},
  });

  try {
    player.setLoopPitchQuantization({
      scale: [0],
      lowestOctave: 0,
      highestOctave: 5,
    });
    // Root in octaves 0–5, in seconds, sorted shortest first (C5 ... C0).
    expect(sendToProcessor).toHaveBeenLastCalledWith({
      type: 'setLoopQuantizePeriods',
      value: [60, 48, 36, 24, 12, 0].map((i) => expect.closeTo(NOTE_PERIODS[i], 6)),
    });

    // The transpose carries quantized loops; rebuilding the periods too would shift them twice.
    player.transpose(2);
    expect(sendToProcessor).toHaveBeenCalledTimes(1);
    expect(setPitchOffset).toHaveBeenLastCalledWith(2);
    expect(player.transposedBySemitones).toBe(2);

    // Fine tune sums with transpose instead of replacing it.
    player.fineTune(-50);
    expect(setPitchOffset).toHaveBeenLastCalledWith(1.5);
    player.transpose(-1);
    expect(setPitchOffset).toHaveBeenLastCalledWith(-1.5);

    player.setLoopPitchQuantization({
      scale: [2],
      lowestOctave: 0,
      highestOctave: 5,
    });
    expect(sendToProcessor).toHaveBeenLastCalledWith({
      type: 'setLoopQuantizePeriods',
      value: [62, 50, 38, 26, 14, 2].map((i) => expect.closeTo(NOTE_PERIODS[i], 6)), // D5 ... D0
    });

    const valid = {
      scale: [0],
      lowestOctave: 0,
      highestOctave: 5,
    } as const;
    expect(() => player.setLoopPitchQuantization({ ...valid, scale: [NaN] })).toThrow(RangeError);
    expect(() => player.setLoopPitchQuantization({ ...valid, scale: [Infinity] })).toThrow(
      RangeError,
    );
    expect(() =>
      player.setLoopPitchQuantization({ ...valid, highestOctave: 10, scale: [0] }),
    ).toThrow(RangeError);
    expect(() => player.setLoopPitchQuantization({ ...valid, scale: [] })).toThrow(RangeError);
    expect(() =>
      player.setLoopPitchQuantization({ ...valid, lowestOctave: 0.5, scale: [0] }),
    ).toThrow(RangeError);
    expect(() =>
      player.setLoopPitchQuantization({ ...valid, lowestOctave: 6, scale: [0] }),
    ).toThrow(RangeError);
  } finally {
    player.dispose();
    expect(() => player.setLoopEnabled(false)).not.toThrow();
    vi.unstubAllGlobals();
  }
});

it('connects pitch LFO to every voice detune and maps normalized depth to cents', async () => {
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
  const context = Object.assign(new EventTarget(), { currentTime: 0 });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });
  const detunes = [{}, {}];

  try {
    await initTestPlayer(player, {
      applyToAllVoices: (apply) =>
        detunes.forEach((detune) =>
          apply({
            getParam: (name: string) => (name === 'detune' ? detune : null),
            setParam() {},
            setLoopPoints() {},
          } as never),
        ),
    });
    expect(player.pitchLFO!.connect).toHaveBeenCalledTimes(2);
    detunes.forEach((detune) => expect(player.pitchLFO!.connect).toHaveBeenCalledWith(detune));

    player.applyParams({ pitchLFODepth: 1 });
    expect(player.pitchLFO!.setDepth).toHaveBeenLastCalledWith(200);
    player.applyParams({ pitchLFODepth: 0 });
    expect(player.pitchLFO!.setDepth).toHaveBeenLastCalledWith(0);
  } finally {
    player.dispose();
    vi.unstubAllGlobals();
  }
});

describe('SamplePlayer.applyParams', () => {
  it('applies only valid parameter values', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    const { SamplePlayer } = await import('./SamplePlayer');
    const setVolume = vi.fn();
    const setGlideTime = vi.fn();
    const setTempo = vi.fn();
    const setFeedbackPitchScale = vi.fn();
    const player = {
      setVolume,
      setGlideTime,
      setTempo,
      setFeedbackPitchScale,
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.applyParams.call(player, {
      volume: 0.75,
      glide: 0.2,
      unknown: 1,
      tempo: 301,
      feedbackPitch: 0.3,
    } as never);

    expect(setVolume).toHaveBeenCalledWith(0.75);
    expect(setGlideTime).toHaveBeenCalledWith(0.2);
    expect(setTempo).not.toHaveBeenCalled();
    expect(setFeedbackPitchScale).not.toHaveBeenCalled();
  });
});

describe('SamplePlayer envelope config', () => {
  it('scales duration through the normal update path without storing a second duration', async () => {
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
    const setEnvelopeConfig = vi.fn();
    const changed = vi.fn();
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    await initTestPlayer(player, {
      applyToAllVoices: (apply) =>
        apply({
          setEnvelopeConfig,
          getParam: () => null,
          setParam() {},
          setLoopPoints() {},
        } as never),
      dispose() {},
    });
    player.onMessage('envelope:changed', changed);
    const shape = {
      ...envConfig.shape,
      mode: { type: 'sustain' } as const,
      points: [
        { time: 5, value: 0, curve: 'linear' } as const,
        { time: 6, value: 1, curve: 'exponential' } as const,
        { time: 9, value: 0 } as const,
      ],
    };

    try {
      // A supplied shape is scaled in the same update, before playback speed is applied.
      player.updateEnvelope('amp', { ...envConfig, shape, duration: 2 });
      const config = player.getEnvelope('amp');
      expect(config.shape).toEqual({
        ...shape,
        points: shape.points.map((point, i) => ({ ...point, time: [5, 5.5, 7][i] })),
      });
      expect(shape.points.map((point) => point.time)).toEqual([5, 6, 9]);
      expect(player.getEnvelopeDuration('amp')).toBe(2);
      expect(config.timeScale).toBe(2);
      expect(config).not.toHaveProperty('duration');
      expect(setEnvelopeConfig).toHaveBeenCalledExactlyOnceWith('amp', config);
      expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ config }));

      // A duration-only update scales the stored shape and preserves its other settings.
      player.updateEnvelope('amp', { duration: 8 });
      const resized = player.getEnvelope('amp');
      expect(player.getEnvelopeDuration('amp')).toBe(8);
      expect(resized).toMatchObject({ enabled: false, timeScale: 2 });

      setEnvelopeConfig.mockClear();
      changed.mockClear();
      for (const duration of [0, -1, NaN, Infinity]) {
        expect(() => player.updateEnvelope('amp', { duration })).toThrow(RangeError);
      }
      expect(player.getEnvelope('amp')).toEqual(resized);
      expect(setEnvelopeConfig).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('resets an envelope to defaults at the current sample duration', async () => {
    const { SamplePlayer } = await import('./SamplePlayer');
    const updateEnvelope = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      updateEnvelope,
    }) as SamplePlayer;
    Object.defineProperty(player, 'sampleDuration', { value: 4 });

    player.resetEnvelope('pitch');

    expect(updateEnvelope).toHaveBeenCalledWith(
      'pitch',
      createDefaultSampleEnvelopeConfig('pitch', 4),
    );
  });

  it('applies a detached snapshot to every voice and emits once', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    const { SamplePlayer } = await import('./SamplePlayer');
    const setEnvelopeConfig = vi.fn();
    const changed = vi.fn();
    const input: EnvelopeConfig = {
      ...envConfig,
      shape: {
        ...envConfig.shape,
        points: envConfig.shape.points.map((point) => ({ ...point })),
      },
    };
    const voices = [0, 1].map(() => ({
      setEnvelopeConfig,
      getParam: () => null,
      setParam() {},
      setLoopPoints() {},
    }));
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    await initTestPlayer(player, {
      allVoices: voices,
      applyToAllVoices: (fn: (voice: (typeof voices)[number]) => void) => voices.forEach(fn),
      allNotesOff() {},
      dispose() {},
    } as unknown as Partial<SampleVoicePool>);
    player.onMessage('envelope:changed', changed);

    try {
      player.updateEnvelope('amp', input);
      setEnvelopeConfig.mockClear();
      changed.mockClear();
      player.updateEnvelope('amp', { depth: 0.5 });
      (input.shape.points[0] as { value: number }).value = 99;

      expect(setEnvelopeConfig).toHaveBeenCalledTimes(2);
      expect(player.getEnvelope('amp').shape.points[0].value).toBe(0);
      expect(player.getEnvelope('amp').depth).toBe(0.5);
      expect(setEnvelopeConfig).toHaveBeenCalledWith(
        'amp',
        expect.objectContaining({ depth: 0.5 }),
      );
      expect(changed).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledWith({
        type: 'envelope:changed',
        senderId: player.nodeId,
        id: 'amp',
        config: expect.objectContaining({ enabled: false, depth: 0.5 }),
      });
      player.updateEnvelope('amp', { depth: -0.25 });
      expect(player.getEnvelope('amp')).toMatchObject({ depth: -0.25 });
      player.updateEnvelope('amp', { depth: 0.75 });
      expect(player.getEnvelope('amp')).toMatchObject({ depth: 0.75 });
      expect(player.getEnvelope('amp')).not.toHaveProperty('amount');
      expect(player.getEnvelope('amp').depth).toBe(0.75);
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('rejects invalid snapshots before mutating voices', async () => {
    const { SamplePlayer } = await import('./SamplePlayer');
    const applyToAllVoices = vi.fn();
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    await initTestPlayer(player, { applyToAllVoices });
    applyToAllVoices.mockClear();

    expect(() => player.updateEnvelope('amp', { ...envConfig, timeScale: 0 })).toThrowError(
      'Invalid envelope settings',
    );
    expect(() =>
      player.updateEnvelope('amp', {
        ...envConfig,
        playbackRateSync: 'yes' as unknown as boolean,
      }),
    ).toThrowError('Invalid envelope settings');
    expect(() =>
      player.updateEnvelope('amp', {
        ...envConfig,
        shape: { ...envConfig.shape, releasePoint: 99 },
      }),
    ).toThrowError('Invalid envelope settings');
    expect(applyToAllVoices).not.toHaveBeenCalled();
    player.dispose();
    vi.unstubAllGlobals();
  });
});

describe('SamplePlayer context watch', () => {
  it('warns and emits context:closed when its context closes, until disposed', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('GainNode', class {});
    vi.doMock('@/nodes/params', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      MacroParam: class {
        dispose() {}
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { SamplePlayer } = await import('./SamplePlayer');

    const context = Object.assign(new EventTarget(), { state: 'running' });
    const player = new SamplePlayer({ context: context as unknown as AudioContext });
    const closed = vi.fn();
    player.onMessage('context:closed', closed);

    context.dispatchEvent(new Event('statechange'));
    expect(warn).not.toHaveBeenCalled();

    context.state = 'closed';
    context.dispatchEvent(new Event('statechange'));
    expect(warn).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();

    player.dispose();
    context.dispatchEvent(new Event('statechange'));
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
    vi.doUnmock('@/nodes/params');
    vi.unstubAllGlobals();
  });

  it('disposes itself when init fails', async () => {
    vi.resetModules();
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
    vi.doMock('@/nodes/params', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      MacroParam: class {
        dispose() {}
      },
    }));
    vi.doMock('@/nodes/master/createInstrumentBus', () => ({
      createInstrumentBus: () => Promise.reject(new Error('boom')),
    }));
    const { SamplePlayer } = await import('./SamplePlayer');
    const { getNodeById } = await import('../../node-store');

    const context = Object.assign(new EventTarget(), { state: 'running' });
    const removeListener = vi.spyOn(context, 'removeEventListener');
    const player = new SamplePlayer({ context: context as unknown as AudioContext });
    expect(getNodeById(player.nodeId)).toBe(player);

    await expect(player.init()).rejects.toThrow('Failed to initialize SamplePlayer: boom');
    expect(getNodeById(player.nodeId)).toBeNull();
    expect(removeListener).toHaveBeenCalledWith('statechange', expect.any(Function));

    vi.doUnmock('@/nodes/params');
    vi.doUnmock('@/nodes/master/createInstrumentBus');
    vi.unstubAllGlobals();
  });
});
